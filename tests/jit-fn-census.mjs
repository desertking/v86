#!/usr/bin/env node
// Function census (fn_census.rs): default-off admission census for a future function tier.
// It records direct-CALL targets reached from compiled code, analyses each target once
// (unit admission, stack-window shape, slot-promotion and P4 eligibility) and probes the
// stack window at every recorded entry. It emits no tier code.
//
// Fixture: protected mode, own GDT/IDT, paging on. 0..8 MB identity, except:
//   0x600000  present, never touched          -> window probe: not resident, must stay unfilled
//   0x610000  present, only ever read          -> resident read-only entry
//   0x900000  maps physical 0x500000 (RW)      -> resident writable, NOT identity
// Phase 1 calls eight small functions from a hot loop, phase 2 calls the stack leaf with
// ESP on the non-identity page and a function spanning four code pages. A port write
// stops the guest at checkpoints for the proof sequence (revocation, nested entry,
// generation exhaustion). A second fixture faults inside compiled code to pin where the
// retired count stands at the exception hook.
//
// Arms: off (never enabled), on, offAfterOn (enabled then disabled before the run), and
// the mutations (each must make this test fail; run with --mutation=N to see it).
//
//   node tests/jit-fn-census.mjs [--mutation=bits]

const { V86 } = await import("../build/libv86.mjs");

const MUTATION = +(process.argv.find(a => a.startsWith("--mutation="))?.split("=")[1] ?? 0);

const BASE = 0x100000, ENTRY_OFF = 0x20, IMAGE = 0x8000;
const PD = 0x200000, PT0 = 0x201000, PT1 = 0x202000, PT2 = 0x203000;
const STACK = 0x380000, UNTOUCHED = 0x600000, READ_ONLY = 0x610000, INVL = 0x700000;
const ALIAS_VIRT = 0x900000, ALIAS_PHYS = 0x500000;
const GDT_OFF = 0xE00, GDTR_OFF = 0xE20, IDT_OFF = 0xE30, IDTR_OFF = 0xEB8;
const FN_OFF = 0x1000, BIG_OFF = 0x2000, SMC_OFF = 0x6000, PF_OFF = 0x7000;
const CHECK_PORT = 0x5F0;
const ITER = 30000, ITER2 = 4000;
const MEM_SIZE = 32 * 1024 * 1024, TIMEOUT_MS = 120000;

const U = { GUEST_CALL: 1, GUEST_CALL_INDIRECT: 2, INDIRECT_JUMP: 4, STATE_INSN: 8, HELPER_REENTRY: 16, PAGE_BUDGET: 32 };
const W = { ESP_UNTRACKED: 1, ESP_ALIGN: 2, ESP_MERGE: 4, ESP_UNBALANCED: 8, OUT_CALL: 16, EXTENT_PAGES: 32, CALLEE_ESP_UNKNOWN: 64 };
const P4 = { FLDCW: 1, DEPTH_MERGE: 2, DEPTH_UNKNOWN: 4, STRICT_FPU: 8, FPU_ENV: 16, NO_X87: 32 };
const WP = { NOT_RESIDENT: 1, READONLY: 2, NO_USER: 4, MAPPED: 8, HAS_CODE: 16, NOT_IDENTITY: 32, WRAP: 64, SS: 128, EXHAUSTED: 256, EXTENT: 512, NO_STATIC: 1024 };
const R = { CSTART: 34, CCOUNT: 35, RETSUM: 36, WEIP: 32, VIRT: 0, PHYS: 1, ENTRIES: 2, UNIT: 3, WSTATIC: 4, PROMO: 5, P4: 6, INSNS: 7, BLOCKS: 8, BYTES: 9, PAGES: 10, LO: 12, HI: 13, WADM: 14, WREF: 15, WSEEN: 16, WMAXP: 17, SMC: 18, FRAME: 19, OTHER: 20, X87: 21, RSTART: 24, RCOUNT: 25, FLAGS: 26, OUTCALLS: 27 };

function header(dv, entry, end)
{
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    [MAGIC, FLAGS, (-(MAGIC + FLAGS)) >>> 0, BASE, BASE, end, BASE + 0x10000, entry]
        .forEach((v, i) => dv.setUint32(i * 4, v, true));
}

function asm(buf, start)
{
    const dv = new DataView(buf.buffer);
    const a = { o: start };
    a.emit = (...b) => { for(const x of b) buf[a.o++] = x & 0xff; };
    a.u32 = v => { dv.setUint32(a.o, v >>> 0, true); a.o += 4; };
    a.u16 = v => { dv.setUint16(a.o, v & 0xffff, true); a.o += 2; };
    a.here = () => BASE + a.o;
    a.call = target => { a.emit(0xE8); a.u32(target - (BASE + a.o + 4)); };
    a.jmp = target => { a.emit(0xE9); a.u32(target - (BASE + a.o + 4)); };
    a.jnz = target => { a.emit(0x0F, 0x85); a.u32(target - (BASE + a.o + 4)); };
    a.out = v => { a.emit(0xBA); a.u32(CHECK_PORT); a.emit(0xB0, v, 0xEE); };
    return a;
}

function prologue(buf, a)
{
    const dv = new DataView(buf.buffer);
    buf.set([0,0,0,0,0,0,0,0, 0xFF,0xFF,0,0,0,0x9A,0xCF,0, 0xFF,0xFF,0,0,0,0x92,0xCF,0], GDT_OFF);
    dv.setUint16(GDTR_OFF, 23, true);
    dv.setUint32(GDTR_OFF + 2, BASE + GDT_OFF, true);
    const H = BASE + PF_OFF, e14 = IDT_OFF + 14 * 8;
    dv.setUint16(e14, H & 0xFFFF, true);
    dv.setUint16(e14 + 2, 0x08, true);
    buf[e14 + 5] = 0x8E;
    dv.setUint16(e14 + 6, H >>> 16, true);
    dv.setUint16(IDTR_OFF, 16 * 8 - 1, true);
    dv.setUint32(IDTR_OFF + 2, BASE + IDT_OFF, true);
    a.emit(0x0F, 0x01, 0x15); a.u32(BASE + GDTR_OFF);
    a.emit(0xEA); a.u32(0); a.u16(0x08);
    dv.setUint32(a.o - 6, BASE + a.o, true);
    a.emit(0x66, 0xB8, 0x10, 0x00, 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0);
    a.emit(0xBC); a.u32(STACK);
    a.emit(0x0F, 0x01, 0x1D); a.u32(BASE + IDTR_OFF);
    a.emit(0xB8); a.u32(PD);
    a.emit(0x0F, 0x22, 0xD8);
    a.emit(0x0F, 0x20, 0xC0);
    a.emit(0x0D); a.u32(0x80000000);
    a.emit(0x0F, 0x22, 0xC0);
    a.emit(0xDB, 0xE3);
}

function page_tables(mem)
{
    const dv = new DataView(mem.buffer, mem.byteOffset);
    dv.setUint32(PD + 0, PT0 | 3, true);
    dv.setUint32(PD + 4, PT1 | 3, true);
    dv.setUint32(PD + 8, PT2 | 3, true);
    for(let i = 0; i < 1024; i++)
    {
        dv.setUint32(PT0 + i * 4, (i << 12) | 3, true);
        dv.setUint32(PT1 + i * 4, ((i + 1024) << 12) | 3, true);
    }
    dv.setUint32(PT2 + ((ALIAS_VIRT >>> 12) & 0x3FF) * 4, ALIAS_PHYS | 3, true);
}

function build_census_image()
{
    const buf = new Uint8Array(IMAGE);
    header(new DataView(buf.buffer), BASE + ENTRY_OFF, BASE + IMAGE);
    const F = {};
    const f = asm(buf, FN_OFF);
    F.leaf = f.here();
    f.emit(0x55, 0x8B, 0xEC);                       // push ebp; mov ebp, esp
    f.emit(0x83, 0xEC, 0x08);                       // sub esp, 8
    f.emit(0x8B, 0x45, 0x08);                       // mov eax, [ebp+8]
    f.emit(0x89, 0x45, 0xF8);                       // mov [ebp-8], eax
    f.emit(0xD9, 0x45, 0xF8);                       // fld dword [ebp-8]
    f.emit(0xD9, 0x5D, 0xF8);                       // fstp dword [ebp-8]
    f.emit(0x8B, 0x45, 0xF8);                       // mov eax, [ebp-8]
    f.emit(0xC9, 0xC2, 0x04, 0x00);                 // leave; ret 4
    F.caller = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0x6A, 0x07);           // push ebp; mov ebp, esp; push 7
    f.call(F.leaf);
    f.emit(0x5D, 0xC3);                             // pop ebp; ret
    F.ind = f.here();
    f.emit(0xB8); f.u32(F.ind + 7);                 // mov eax, tgt
    f.emit(0xFF, 0xE0);                             // jmp eax
    f.emit(0xC3);                                   // tgt: ret
    F.fldcw = f.here();
    f.emit(0x83, 0xEC, 0x04, 0xD9, 0x3C, 0x24, 0xD9, 0x2C, 0x24);   // sub esp,4; fnstcw [esp]; fldcw [esp]
    f.emit(0xD9, 0xE8, 0xDD, 0xD8, 0x83, 0xC4, 0x04, 0xC3);         // fld1; fstp st0; add esp,4; ret
    F.align = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0);     // push ebp; mov ebp,esp; and esp,-16
    f.emit(0x89, 0x04, 0x24, 0x8B, 0xE5, 0x5D, 0xC3); // mov [esp],eax; mov esp,ebp; pop ebp; ret
    F.state = f.here();
    f.emit(0x0F, 0x01, 0x3D); f.u32(INVL);          // invlpg [INVL]
    f.emit(0xC3);
    F.xmerge = f.here();
    f.emit(0xF7, 0xC1, 0x01, 0x00, 0x00, 0x00);     // test ecx, 1
    f.emit(0x74, 0x02, 0xD9, 0xE8);                 // jz +2; fld1
    f.emit(0xDB, 0xE2, 0xC3);                       // fnclex; ret
    F.ebpgpr = f.here();
    f.emit(0x55, 0x89, 0xE5, 0x55);                 // push ebp; mov ebp,esp; push ebp
    f.emit(0x89, 0xC5, 0xD1, 0xED, 0x5D);           // mov ebp,eax; shr ebp,1; pop ebp
    f.emit(0x8B, 0x45, 0x08, 0xC9, 0xC2, 0x04, 0x00); // mov eax,[ebp+8]; leave; ret 4
    F.diamond = f.here();
    f.emit(0x55, 0x89, 0xE5);                       // push ebp; mov ebp, esp
    f.emit(0xF7, 0xC1, 0x01, 0, 0, 0, 0x74, 0x02);  // test ecx, 1; jz wide
    f.emit(0xEB, 0x0E);                             // jmp join
    f.emit(0x81, 0xEC); f.u32(256);                 // wide: sub esp, 256
    f.emit(0x89, 0xE5);                             // mov ebp, esp
    f.emit(0x81, 0xC4); f.u32(256);                 // add esp, 256
    f.emit(0x8B, 0x45, 0xE0, 0x5D, 0xC3);           // join: mov eax, [ebp-32]; pop ebp; ret
    F.reg = f.here();
    f.emit(0xB8, 0x01, 0, 0, 0, 0xC3);              // mov eax, 1; ret
    F.cdecl = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0x6A, 0x05);           // push ebp; mov ebp, esp; push 5
    f.call(F.reg);
    f.emit(0x83, 0xC4, 0x04, 0x5D, 0xC3);           // add esp, 4; pop ebp; ret
    F.icall = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0xB8); f.u32(F.leaf);  // push ebp; mov ebp, esp; mov eax, leaf
    f.emit(0x6A, 0x01, 0xFF, 0xD0, 0x5D, 0xC3);     // push 1; call eax; pop ebp; ret
    F.mixret = f.here();
    f.emit(0x31, 0xC0, 0x85, 0xC0, 0x74, 0x01, 0xC3); // xor eax,eax; test eax,eax; jz +1; ret
    f.emit(0xC2, 0x04, 0x00);                       // ret 4
    F.mixcaller = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0x6A, 0x03);           // push ebp; mov ebp, esp; push 3
    f.call(F.mixret);
    f.emit(0x5D, 0xC3);                             // pop ebp; ret
    F.big = BASE + BIG_OFF;
    for(let p = 0; p < 3; p++)
    {
        const big = asm(buf, BIG_OFF + p * 0x1000);
        big.emit(0x90);
        big.jmp(BASE + BIG_OFF + (p + 1) * 0x1000);
    }
    asm(buf, BIG_OFF + 0x3000).emit(0x90, 0xC3);
    F.smc = BASE + SMC_OFF;
    asm(buf, SMC_OFF).emit(0xB8, 0x02, 0, 0, 0, 0xC3);
    const pf = asm(buf, PF_OFF);
    pf.emit(0xF4);
    pf.emit(0xEB, 0xFE);

    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0xB9); a.u32(ITER);
    const l1 = a.here();
    a.emit(0x51); a.call(F.leaf);                   // push ecx; call leaf
    a.call(F.caller); a.call(F.ind); a.call(F.fldcw); a.call(F.align);
    a.emit(0xA1); a.u32(INVL);                      // mov eax, [INVL]
    a.call(F.state); a.call(F.xmerge); a.call(F.reg); a.call(F.diamond);
    a.call(F.cdecl); a.call(F.icall); a.call(F.mixcaller);
    a.emit(0x51); a.call(F.ebpgpr);
    a.emit(0x49); a.jnz(l1);
    a.emit(0xB9); a.u32(ITER2);
    const l2 = a.here();
    a.emit(0x89, 0xE3);                             // mov ebx, esp
    a.emit(0xBC); a.u32(ALIAS_VIRT + 0x800);        // mov esp, alias
    a.emit(0x51); a.call(F.leaf);
    a.emit(0x89, 0xDC);                             // mov esp, ebx
    a.call(F.big);
    a.emit(0x88, 0x0D); a.u32(F.smc + 0x800);      // mov [smc page + 0x800], cl
    a.call(F.smc);
    a.emit(0x49); a.jnz(l2);
    a.emit(0xC6, 0x05); a.u32(F.smc); a.emit(0xC3);   // mov byte [smc], ret: the body shrinks to RET
    a.emit(0xB9); a.u32(ITER2);
    const l3 = a.here();
    a.call(F.smc);
    a.emit(0x49); a.jnz(l3);
    a.emit(0xC7, 0x05); a.u32(STACK - 0x100); a.u32(1);  // write the stack page
    a.emit(0xA1); a.u32(READ_ONLY);                 // mov eax, [READ_ONLY]: read-only fill
    a.out(1);
    a.emit(0x0F, 0x01, 0x3D); a.u32(STACK - 0x100); // invlpg stack page
    a.out(2);
    a.emit(0xC7, 0x05); a.u32(STACK - 0x100); a.u32(2);  // nested entry: stack resident again
    a.out(3);
    a.emit(0x0F, 0x01, 0x3D); a.u32(STACK - 0x100);
    a.emit(0xC7, 0x05); a.u32(STACK - 0x100); a.u32(3);
    a.emit(0x0F, 0x01, 0x3D); a.u32(STACK - 0x100);
    a.emit(0xC7, 0x05); a.u32(STACK - 0x100); a.u32(4);
    a.out(4);
    a.emit(0x0F, 0x01, 0x3D); a.u32(STACK - 0x100);
    a.emit(0xC7, 0x05); a.u32(STACK - 0x100); a.u32(5);
    a.out(5);
    a.emit(0xF4);
    build_census_image.F = F;
    return { buf, F };
}

function build_dep_image()
{
    const buf = new Uint8Array(IMAGE);
    header(new DataView(buf.buffer), BASE + ENTRY_OFF, BASE + IMAGE);
    const F = { caller: BASE + 0x1000, callee: BASE + 0x2000, other: BASE + 0x3000, other2: BASE + 0x4000 };
    const c = asm(buf, 0x1000);
    c.emit(0x55, 0x8B, 0xEC, 0x6A, 0x01);           // push ebp; mov ebp, esp; push 1
    c.call(F.callee);
    c.emit(0xC9, 0xC3);                             // leave; ret
    asm(buf, 0x2000).emit(0xC2, 0x04, 0x00);        // ret 4
    const o = asm(buf, 0x3000);
    o.emit(0xB8, 0x02, 0, 0, 0);                    // mov eax, 2
    o.call(F.other2);
    o.emit(0xC3);
    asm(buf, 0x4000).emit(0xC3);
    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0xB9); a.u32(200000);
    const l1 = a.here();
    a.call(F.caller); a.call(F.other);
    a.emit(0x49); a.jnz(l1);
    a.out(1);
    a.emit(0xB9); a.u32(ITER2);
    const l2 = a.here();
    a.emit(0x88, 0x0D); a.u32(F.other2 + 0x800);    // mov [other2 page + 0x800], cl: a callee page the caller does not use
    a.call(F.caller); a.call(F.other);
    a.emit(0x49); a.jnz(l2);
    a.out(2);
    a.emit(0xC6, 0x05); a.u32(F.callee + 1); a.emit(0x08);   // the callee becomes ret 8
    a.emit(0xB9); a.u32(200000);
    const l3 = a.here();
    a.call(F.caller);
    a.emit(0x49); a.jnz(l3);
    a.emit(0xF4);
    return { buf, F };
}

function build_fault_image(k, iters = 200000)
{
    const buf = new Uint8Array(IMAGE);
    header(new DataView(buf.buffer), BASE + ENTRY_OFF, BASE + IMAGE);
    const pf = asm(buf, PF_OFF);
    pf.emit(0xF4, 0xEB, 0xFE);
    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0xBA); a.u32(0x800000 - 4 * iters);
    a.emit(0xB9); a.u32(iters + 16);
    const loop = a.here();
    a.emit(0x8B, 0x1A);
    a.emit(0x83, 0xC2, 0x04);
    for(let i = 0; i < k; i++) a.emit(0x40);
    a.emit(0x49); a.jnz(loop);
    a.emit(0xF4);
    return { buf };
}

function rows_of(cpu, w)
{
    const n = w.fn_census_row_count() >>> 0, words = w.fn_census_row_words() >>> 0;
    const ptr = w.fn_census_rows_ptr() >>> 0;
    const a = new Uint32Array(cpu.wasm_memory.buffer, ptr, n * words);
    const rows = new Map();
    for(let i = 0; i < n; i++) rows.set(a[i * words], Array.from(a.subarray(i * words, (i + 1) * words)));
    return rows;
}

const generation = w => (w.fn_census_window_generation_hi() >>> 0) * 2 ** 32 + (w.fn_census_window_generation_lo() >>> 0);

function run({ build, census, toggle, mutation = 0, jit = true, onCheck })
{
    return new Promise((resolve, reject) => {
        const emulator = new V86({ autostart: false, memory_size: MEM_SIZE, disable_jit: jit ? 0 : 1, log_level: 0 });
        const img = build();
        const modules = [];
        const checks = {};
        let timer, fp;
        const finish = status => {
            clearTimeout(timer);
            try { emulator.stop(); } catch(e) {}
            delete globalThis.__jitPublicationCapture;
            const cpu = emulator.v86.cpu, w = cpu.wm.exports;
            const out = {
                status, img, modules, fp, checks,
                rows: rows_of(cpu, w),
                calls: Array.from(new Uint32Array(cpu.wasm_memory.buffer, w.fn_census_calls_ptr() >>> 0, (w.fn_census_call_count() >>> 0) * 4)),
                stats: Array.from({ length: w.fn_census_stat_count() }, (_, i) => w.fn_census_stat(i)),
                gen: generation(w),
                counter: new Uint32Array(cpu.wasm_memory.buffer, 664, 1)[0],
                hook: w.fn_census_last_exception_counter() >>> 0,
                vector: w.fn_census_last_exception_vector() >>> 0,
                eax: cpu.reg32[0] >>> 0,
            };
            w.fn_census_set_enabled(0);
            w.fn_census_set_mutation(0);
            w.fn_census_reset();
            resolve(out);
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            try {
                const cpu = emulator.v86.cpu, w = cpu.wm.exports;
                cpu.reboot_internal();
                cpu.reset_memory();
                const fp0 = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                const defaultOn = w.fn_census_enabled() >>> 0;
                w.fn_census_reset();
                w.fn_census_set_mutation(mutation);
                if(census || toggle) w.fn_census_set_enabled(1);
                if(toggle) w.fn_census_set_enabled(0);
                fp = { before: fp0, after: [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0], defaultOn };
                globalThis.__jitPublicationCapture = {
                    begin(start, tableIndex, slot, bytes) { modules.push({ start, bytes: bytes.slice() }); return null; },
                };
                cpu.jit_clear_cache?.();
                cpu.load_multiboot(img.buf.buffer);
                page_tables(cpu.mem8);
                cpu.io.register_write(CHECK_PORT, cpu, v => { checks[v] = onCheck ? onCheck(v, cpu, w) : true; });
                timer = setTimeout(() => finish("HANG"), TIMEOUT_MS);
                emulator.run();
            }
            catch(e) { reject(e); }
        });
    });
}

const failures = [];
const fail = msg => failures.push(msg);
const hex = v => "0x" + (v >>> 0).toString(16);

const proofs = {};
const onCheck = (v, cpu, w) => {
    const lo = STACK - 0x200, hi = STACK - 0x80;
    if(v === 1)
    {
        proofs.ownerSmcStart = w.fn_census_owner_of(build_census_image.F.smc);
        proofs.ownerSmcDead = w.fn_census_owner_of(build_census_image.F.smc + 4);
        proofs.a = w.fn_census_proof_admit(lo, hi);
        proofs.aValid1 = w.fn_census_proof_valid(proofs.a);
        proofs.untouched = w.fn_census_window_probe(UNTOUCHED, UNTOUCHED + 0x100);
        proofs.untouchedEntryAfter = w.fn_census_debug_tlb_entry(UNTOUCHED >>> 12);
        proofs.readOnly = w.fn_census_window_probe(READ_ONLY, READ_ONLY + 0x100);
        proofs.alias = w.fn_census_window_probe(ALIAS_VIRT + 0x700, ALIAS_VIRT + 0x900);
        proofs.code = w.fn_census_window_probe(BASE + FN_OFF, BASE + FN_OFF + 0x10);
        proofs.wrap = w.fn_census_window_probe(0xFFFFF000, 0xFFFFF000);
        proofs.extent = w.fn_census_window_probe(STACK - 0x5000, STACK);
    }
    else if(v === 2)
    {
        proofs.aValid2 = w.fn_census_proof_valid(proofs.a);
        proofs.bWhileAbsent = w.fn_census_proof_admit(lo, hi);
    }
    else if(v === 3)
    {
        proofs.b = w.fn_census_proof_admit(lo, hi);
        proofs.bValid3 = w.fn_census_proof_valid(proofs.b);
        proofs.aValid3 = w.fn_census_proof_valid(proofs.a);
    }
    else if(v === 4)
    {
        proofs.aValid4 = w.fn_census_proof_valid(proofs.a);
        proofs.bValid4 = w.fn_census_proof_valid(proofs.b);
        w.fn_census_test_set_window_generation(0xFFFFFFFE, 0xFFFFFFFF);
        proofs.c = w.fn_census_proof_admit(lo, hi);
        proofs.cValid4 = w.fn_census_proof_valid(proofs.c);
    }
    else if(v === 5)
    {
        proofs.cValid5 = w.fn_census_proof_valid(proofs.c);
        proofs.exhausted = w.fn_census_window_probe(lo, hi);
        proofs.dAdmit = w.fn_census_proof_admit(lo, hi);
    }
    return true;
};

const off = await run({ build: build_census_image, census: false });
const on = await run({ build: build_census_image, census: true, mutation: MUTATION, onCheck });
const offAfterOn = await run({ build: build_census_image, census: false, toggle: true });
const { F } = on.img;

for(const [name, r] of [["off", off], ["on", on], ["offAfterOn", offAfterOn]])
{
    if(r.status !== "halt") fail(`${name}: guest did not reach hlt (${r.status})`);
    if(r.fp.defaultOn !== 0) fail(`${name}: census must default OFF`);
}
const fpEq = (x, y) => x[0] === y[0] && x[1] === y[1];
if(!fpEq(off.fp.after, off.fp.before)) fail("off: fingerprint moved without the switch");
if(fpEq(on.fp.after, on.fp.before)) fail("on: the census changes generated code, so it must change the fingerprint");
if(!fpEq(offAfterOn.fp.after, off.fp.after)) fail("offAfterOn: fingerprint differs from never-enabled");

function ours(r) { return r.modules.filter(m => m.start >= BASE && m.start < BASE + IMAGE); }
const bytesOf = r => ours(r).map(m => Buffer.from(m.bytes).toString("base64")).join("|");
if(!ours(off).length) fail("fixture was never compiled");
if(bytesOf(off) !== bytesOf(offAfterOn)) fail("module bytes differ after enabling and disabling the census");
if(bytesOf(off) === bytesOf(on)) fail("census on emitted identical modules: the call hook is missing");
for(const [name, r] of [["off", off], ["offAfterOn", offAfterOn]])
{
    if(r.rows.size !== 0) fail(`${name}: rows recorded while off`);
    if(r.stats.some(v => v !== 0)) fail(`${name}: stats moved while off: ${r.stats}`);
    if(r.gen !== 1) fail(`${name}: window generation moved while off (${r.gen}): epoch machinery ran disabled`);
}

const row = addr => on.rows.get(addr >>> 0);
const need = (name, addr) => { const r = row(addr); if(!r) fail(`${name}: no census row for ${hex(addr)}`); return r || new Array(40).fill(0); };
const leaf = need("leaf", F.leaf), caller = need("caller", F.caller), ind = need("ind", F.ind);
const fldcw = need("fldcw", F.fldcw), align = need("align", F.align), state = need("state", F.state);
const ebpgpr = need("ebpgpr", F.ebpgpr);
if(ebpgpr[R.UNIT] !== 0 || ebpgpr[R.WSTATIC] !== 0 || (ebpgpr[R.LO] | 0) !== -8 || ebpgpr[R.HI] !== 8) fail(`ebp used as a GPR between push/pop: ${hex(ebpgpr[R.WSTATIC])} [${ebpgpr[R.LO] | 0}, ${ebpgpr[R.HI]})`);
const xmerge = need("xmerge", F.xmerge), reg = need("reg", F.reg), big = need("big", F.big), smc = need("smc", F.smc);

if(leaf[R.UNIT] !== 0) fail(`leaf unit refused ${hex(leaf[R.UNIT])}`);
if(leaf[R.WSTATIC] !== 0) fail(`leaf window statically refused ${hex(leaf[R.WSTATIC])}`);
if((leaf[R.LO] | 0) !== -12 || leaf[R.HI] !== 8) fail(`leaf frame [${leaf[R.LO] | 0}, ${leaf[R.HI]}) != [-12, 8)`);
if(leaf[R.FRAME] !== 5 || leaf[R.OTHER] !== 0) fail(`leaf frame/other accesses ${leaf[R.FRAME]}/${leaf[R.OTHER]} != 5/0`);
if(leaf[R.P4] & ~P4.STRICT_FPU) fail(`leaf P4 ${hex(leaf[R.P4])}`);
if(leaf[R.WADM] < ITER * 0.5) fail(`leaf window admitted ${leaf[R.WADM]} < ${ITER * 0.5}`);
if(leaf[R.WREF] < ITER2 * 0.5) fail(`leaf window refused ${leaf[R.WREF]} < ${ITER2 * 0.5} (alias stack)`);
if(leaf[R.WSEEN] !== WP.NOT_IDENTITY) fail(`leaf refusals seen ${hex(leaf[R.WSEEN])} != NOT_IDENTITY only`);
if(leaf[R.ENTRIES] !== leaf[R.WADM] + leaf[R.WREF]) fail("leaf entries != admitted + refused");
if(caller[R.UNIT] !== U.GUEST_CALL || caller[R.WSTATIC] !== W.OUT_CALL || caller[R.OUTCALLS] !== 1) fail(`caller (stdcall callee) unit ${hex(caller[R.UNIT])} window ${hex(caller[R.WSTATIC])}, want guest call / out-call only`);
const callsOf = r => Array.from({ length: r[R.CCOUNT] }, (_, i) => on.calls.slice((r[R.CSTART] + i) * 4, (r[R.CSTART] + i + 1) * 4));
const cc = callsOf(caller);
if(cc.length !== 1 || cc[0][1] !== F.leaf || cc[0][2] !== 2 || cc[0][3] !== 4) fail(`caller call sites ${JSON.stringify(cc)}, want one site to leaf, callee ret known, imm 4`);
if(leaf[R.RETSUM] !== (0x10000 | 4)) fail(`leaf ret summary ${hex(leaf[R.RETSUM])}`);
const cdecl = need("cdecl", F.cdecl), icall = need("icall", F.icall), mixcaller = need("mixcaller", F.mixcaller);
if(cdecl[R.WSTATIC] !== W.OUT_CALL) fail(`cdecl caller window ${hex(cdecl[R.WSTATIC])}, want out-call only`);
if(icall[R.UNIT] !== U.GUEST_CALL_INDIRECT || icall[R.WSTATIC] !== W.CALLEE_ESP_UNKNOWN) fail(`indirect caller ${hex(icall[R.UNIT])}/${hex(icall[R.WSTATIC])}`);
const ic = callsOf(icall);
if(ic.length !== 1 || ic[0][1] !== 0 || ic[0][2] !== 1) fail(`indirect call site ${JSON.stringify(ic)}`);
if(!(mixcaller[R.WSTATIC] & W.CALLEE_ESP_UNKNOWN) || callsOf(mixcaller)[0]?.[2] !== 4) fail(`mixed-ret callee: caller window ${hex(mixcaller[R.WSTATIC])}, site ${JSON.stringify(callsOf(mixcaller))}`);
if(!(ind[R.UNIT] & U.INDIRECT_JUMP)) fail(`ind unit ${hex(ind[R.UNIT])}`);
if(fldcw[R.UNIT] !== 0 || !(fldcw[R.P4] & P4.FLDCW) || fldcw[R.WSTATIC] !== 0) fail(`fldcw ${hex(fldcw[R.UNIT])}/${hex(fldcw[R.P4])}/${hex(fldcw[R.WSTATIC])}`);
if(align[R.UNIT] !== 0 || !(align[R.WSTATIC] & W.ESP_ALIGN)) fail(`align ${hex(align[R.UNIT])}/${hex(align[R.WSTATIC])}`);
if(align[R.WEIP] !== F.align + 3) fail(`align: first window refusal at ${hex(align[R.WEIP])}, want the and esp at ${hex(F.align + 3)}`);
if(leaf[R.WEIP] !== 0) fail(`leaf: window refusal site ${hex(leaf[R.WEIP])} recorded without a refusal`);
if(align[R.WSEEN] !== WP.NO_STATIC) fail(`align probe ${hex(align[R.WSEEN])} != NO_STATIC_WINDOW`);
if(!(state[R.UNIT] & U.STATE_INSN)) fail(`state unit ${hex(state[R.UNIT])}`);
if(xmerge[R.UNIT] !== 0 || !(xmerge[R.P4] & P4.DEPTH_MERGE)) fail(`xmerge ${hex(xmerge[R.UNIT])}/${hex(xmerge[R.P4])}`);
if(reg[R.UNIT] !== 0 || reg[R.WSTATIC] !== 0 || !(reg[R.P4] & P4.NO_X87) || reg[R.HI] !== 4 || (reg[R.LO] | 0) !== 0) fail(`reg ${JSON.stringify(reg.slice(0, 14))}`);
const diamond = need("diamond", F.diamond);
if(!(diamond[R.WSTATIC] & W.ESP_MERGE) || diamond[R.WADM] !== 0) fail(`diamond: equal ESP but different EBP at the join must refuse the window (window ${hex(diamond[R.WSTATIC])}, admitted ${diamond[R.WADM]}, frame [${diamond[R.LO] | 0}, ${diamond[R.HI]}))`);
{
    const idx = [...on.rows.keys()].indexOf(F.smc >>> 0);
    const smcRow = on.rows.get(F.smc >>> 0) ?? [];
    if(proofs.ownerSmcStart !== idx + 1) fail(`after SMC re-analysis owner_of(body) = ${proofs.ownerSmcStart}, want row ${idx + 1}`);
    if(proofs.ownerSmcDead !== 0) fail(`after the body shrank to RET, owner_of(old body + 4) = ${proofs.ownerSmcDead}: an obsolete range still owns executed work`);
    if(smcRow[R.INSNS] !== 1) fail(`smc row was not re-analysed to the 1-instruction body (${smcRow[R.INSNS]} instructions)`);
}
if(!(big[R.UNIT] & U.PAGE_BUDGET)) fail(`big unit ${hex(big[R.UNIT])} lacks PAGE_BUDGET`);
if(smc[R.SMC] < ITER2 * 0.5 || smc[R.UNIT] !== 0) fail(`smc row: ${smc[R.SMC]} code-page writes recorded, unit ${hex(smc[R.UNIT])}`);
for(const [addr, r] of on.rows) if(addr !== F.smc && r[R.SMC] !== 0) fail(`${hex(addr)}: ${r[R.SMC]} SMC events on a page nothing writes`);

const stat = on.stats;
if(stat[3] < ITER2 * 0.25) fail(`reanalyses after SMC ${stat[3]} < ${ITER2 * 0.25}`);
if(stat[4] < ITER * 0.5) fail(`tlb revocations ${stat[4]} < ${ITER * 0.5} (invlpg per iteration)`);
if(stat[0] !== [...on.rows.values()].reduce((s, r) => s + r[R.ENTRIES], 0)) fail("calls stat != sum of row entries");

if(on.checks[5] !== true) fail("proof checkpoints did not all run");
const P = proofs;
if(!P.a || P.aValid1 !== 1) fail(`proof A not admitted/valid (${P.a}/${P.aValid1})`);
if(P.untouched !== WP.NOT_RESIDENT) fail(`untouched page probe ${hex(P.untouched)} != NOT_RESIDENT`);
if(P.untouchedEntryAfter !== 0) fail("the probe filled the TLB for an absent page");
if(P.readOnly !== WP.READONLY) fail(`read-only page probe ${hex(P.readOnly)} != READONLY`);
if(P.alias !== WP.NOT_IDENTITY) fail(`alias page probe ${hex(P.alias)} != NOT_IDENTITY`);
if(!(P.code & WP.HAS_CODE)) fail(`code page probe ${hex(P.code)} lacks HAS_CODE`);
if(!(P.wrap & WP.WRAP)) fail(`empty range probe ${hex(P.wrap)} lacks WRAP`);
if(!(P.extent & WP.EXTENT)) fail(`5-page probe ${hex(P.extent)} lacks EXTENT`);
if(P.aValid2 !== 0) fail("proof A survived invlpg of its page");
if(P.bWhileAbsent !== 0) fail("proof admitted while its page has no TLB entry");
if(!P.b || P.bValid3 !== 1) fail("nested proof B not admitted after re-residency");
if(P.aValid3 !== 0) fail("older proof A revalidated by the nested entry");
if(P.aValid4 !== 0 || P.bValid4 !== 0) fail(`two revocations later A/B must stay invalid (${P.aValid4}/${P.bValid4})`);
if(!P.c || P.cValid4 !== 1) fail("proof C at the last generation not admitted");
if(P.cValid5 !== 0) fail("proof C valid after the generation was exhausted");
if(!(P.exhausted & WP.EXHAUSTED) || P.dAdmit !== 0) fail(`exhausted generation still admits (${hex(P.exhausted)}/${P.dAdmit})`);

{
    const snap = (cpu, w) => {
        const rows = rows_of(cpu, w);
        const calls = Array.from(new Uint32Array(cpu.wasm_memory.buffer, w.fn_census_calls_ptr() >>> 0, (w.fn_census_call_count() >>> 0) * 4));
        return { rows, calls };
    };
    const at = {};
    const dep = await run({ build: build_dep_image, census: true, mutation: MUTATION, onCheck: (v, cpu, w) => { at[v] = snap(cpu, w); return true; } });
    at.end = { rows: dep.rows, calls: dep.calls };
    const F2 = dep.img.F;
    const siteOf = (s, addr) => { const r = s?.rows.get(addr >>> 0); return r && r[R.CCOUNT] ? { row: r, site: s.calls.slice(r[R.CSTART] * 4, r[R.CSTART] * 4 + 4) } : { row: r }; };
    if(dep.status !== "halt" || !at[1] || !at[2]) fail(`dependency fixture did not finish (${dep.status})`);
    const p1 = siteOf(at[1], F2.caller), p2 = siteOf(at[2], F2.caller), p3 = siteOf(at.end, F2.caller);
    if(p1.site?.[1] !== F2.callee || p1.site?.[3] !== 4) fail(`dependency fixture: caller site before the write ${JSON.stringify(p1.site)}, want callee imm 4`);
    const o2 = siteOf(at[2], F2.other);
    if(!o2.row || o2.row[R.SMC] === 0) fail("dependency fixture: the caller of the written page was not marked stale");
    if(p2.row?.[R.SMC] !== 0 || p2.site?.[3] !== 4) fail(`a write to an unrelated callee page touched the caller (${p2.row?.[R.SMC]} SMC events, site ${JSON.stringify(p2.site)})`);
    if(!p3.row || p3.row[R.SMC] === 0 || p3.site?.[3] !== 8) fail(`the callee's ret imm changed to 8 on another page, the caller still reports ${JSON.stringify(p3.site)} (${p3.row?.[R.SMC]} SMC events)`);
}

const K = 24;
const faultJit = await run({ build: () => build_fault_image(K), census: true });
const faultInterp = await run({ build: () => build_fault_image(K), census: true, jit: false });
for(const [name, r] of [["faultJit", faultJit], ["faultInterp", faultInterp]])
{
    if(r.status !== "halt" || r.vector !== 14) fail(`${name}: no #PF reached the handler (${r.status}, vector ${r.vector})`);
}
if(!ours(faultJit).length) fail("fault fixture: the loop was never compiled");
if(faultJit.hook !== faultInterp.hook) fail(`count seen at the exception hook differs: page JIT ${faultJit.hook}, interpreter ${faultInterp.hook}`);
if(faultJit.hook >= faultInterp.counter - K) fail("the exception hook saw the faulting activation's own retired count");
const overcount = faultJit.counter - faultInterp.counter;
if(overcount !== K + 3) fail(`after the fault the page JIT counts ${overcount} more than the interpreter (pinned: ${K + 3}, the rest of the faulting block)`);

const report = {
    mutation: MUTATION,
    rows: on.rows.size,
    leaf: { entries: leaf[R.ENTRIES], admitted: leaf[R.WADM], refused: leaf[R.WREF], frame: [leaf[R.LO] | 0, leaf[R.HI]] },
    stats: { calls: stat[0], analyses: stat[2], reanalyses: stat[3], smcOnCandidates: stat[7], revocations: stat[4], revocationsOnWindowPages: stat[5], smc: stat[6], probes: stat[11], admitted: stat[12] },
    proofs: P,
    faultHook: { k: K, jit: { hook: faultJit.hook, after: faultJit.counter }, interpreter: { hook: faultInterp.hook, after: faultInterp.counter } },
};
if(failures.length)
{
    console.error("jit-fn-census " + JSON.stringify(report));
    for(const f of failures) console.error("FAIL: " + f);
    process.exit(1);
}
console.log("jit-fn-census " + JSON.stringify(report));
process.exit(0);
