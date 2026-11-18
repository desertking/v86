#!/usr/bin/env node
// Function units, chained calls (fn_unit.rs, chain switch, default off). A direct CALL inside a
// unit whose target is a published unit becomes a call of the callee's chain function with the
// guest GPRs and the native lazy-flag tuple as values; every failed pre-call check leaves the
// unit at the CALL before it commits, and a RET that does not land where the chain expects
// leaves at the RET.
//
// Fixture: the census fixture's protected-mode setup. The functions live on pages the caller's
// modules may not absorb (region exclusion), so the page JIT reaches them only through the
// dispatcher. Phase 1: `outer` (one page) calls `mid` (another page), which calls `sum`, a leaf
// reading the caller's CF, a leaf setting flags the caller reads, and `pv` (its own page);
// `outer` also calls a function that moves its own return address by two bytes, one that
// rewrites an immediate in `outer`'s continuation every 8192nd call, and an `and esp` frame.
// Between phases the main loop patches `pv` (callee invalidated, dependants dropped and
// recompiled). Phase 3 recurses 40 deep (self calls past the depth cap). Phase 4 runs long
// chained loops that must leave by the shared loop budget. A second image takes a #PF two
// chained calls deep. Expected values are computed here, independently; every arm is also
// compared with the interpreter (registers, memory, retired instruction count).
//
// Arms: interpreter, off (census only), units (chain off), canonical (mode 1), private
// (mode 2), private with `and esp` frames, offAfterOn. The mutations apply to the private arm
// and each must make this test fail (run with --mutation=N to see it).
//
//   node tests/jit-fn-unit-chain.mjs [--mutation=bits]

const { V86 } = await import("../build/libv86.mjs");

const MUTATION = +(process.argv.find(a => a.startsWith("--mutation="))?.split("=")[1] ?? 0);

const BASE = 0x100000, ENTRY_OFF = 0x20, IMAGE = 0x8000;
const PD = 0x200000, PT0 = 0x201000, PT1 = 0x202000;
const STACK = 0x380000, BUF = 0x400000, MARK = 0x401010, UNMAPPED = 0xA00000;
const GDT_OFF = 0xE00, GDTR_OFF = 0xE20, IDT_OFF = 0xE30, IDTR_OFF = 0xEB8;
const FN_LO = 0x2000, FN_HI = 0x7000, PF_OFF = 0x7000;
const OUTER_OFF = 0x2000, LEAF_OFF = 0x3000, MID_OFF = 0x4000, PV_OFF = 0x5000, REC_OFF = 0x6000;
const CHECK_PORT = 0x5F0;
const ITER = 40000, ITER2 = 40000, REC_N = 40, REC_ITER = 3000, LONG_K = 20, LONG_N = 3000, LONG_CALLS = 40;
const FAULT_ITER = 400000, LOOP_COUNTER = 100003;
const MEM_SIZE = 32 * 1024 * 1024, TIMEOUT_MS = 240000;
const S = { ENTRIES: 0, MATCHED: 1, EXITED: 2, COMPILES: 3, PUBLISHED: 4, WRITTEN: 5, FAILED: 6, INVALIDATED: 7,
    NOT_M1: 8, RET_FORM: 9, SHAPE: 10, STATE: 11, INSNS: 19, SITES: 20, UNCHAINED: 21, DROPPED: 22, STALE_PUBLISH: 23,
    MAX_RETIRED: 24 };
const C = { CALLS: 0, FB_DEPTH: 1, FB_BUDGET: 2, FB_TOKEN: 3, FB_MAPPING: 4, CALLEE_EXITED: 5, CALLER_TOKEN: 6,
    RET_MATCHED: 7, RET_MISMATCH: 8 };

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
    for(let i = 0; i < 1024; i++)
    {
        dv.setUint32(PT0 + i * 4, (i << 12) | 3, true);
        dv.setUint32(PT1 + i * 4, ((i + 1024) << 12) | 3, true);
    }
}

function pf_handler(buf)
{
    const pf = asm(buf, PF_OFF);
    pf.emit(0x8B, 0x44, 0x24, 0x04);                // mov eax, [esp+4]: faulting eip
    pf.emit(0xA3); pf.u32(MARK);                    // mov [MARK], eax
    pf.emit(0xF4, 0xEB, 0xFE);
}

function build_main_image()
{
    const buf = new Uint8Array(IMAGE);
    header(new DataView(buf.buffer), BASE + ENTRY_OFF, BASE + IMAGE);
    pf_handler(buf);
    const F = {};

    const l = asm(buf, LEAF_OFF);
    F.sum = l.here();
    l.emit(0x55, 0x8B, 0xEC, 0x8B, 0x4D, 0x08);     // push ebp; mov ebp, esp; mov ecx, [ebp+8]
    l.emit(0x31, 0xC0);                             // xor eax, eax
    const sl = l.here();
    l.emit(0x01, 0xC8, 0xC1, 0xC0, 0x03, 0x49);     // l: add eax, ecx; rol eax, 3; dec ecx
    l.emit(0x75, (sl - (l.here() + 2)) & 0xFF);     // jnz l
    l.emit(0x5D, 0xC2, 0x04, 0x00);                 // pop ebp; ret 4
    l.o = LEAF_OFF + 0x100;
    F.cfadd = l.here();
    l.emit(0x15); l.u32(0x10); l.emit(0xC3);        // adc eax, 0x10; ret: reads the caller's CF
    l.o = LEAF_OFF + 0x140;
    F.setcf = l.here();
    l.emit(0x39, 0xD8, 0xC3);                       // cmp eax, ebx; ret: the caller reads CF
    l.o = LEAF_OFF + 0x180;
    F.retmod = l.here();
    l.emit(0x5A, 0x83, 0xC2, 0x02, 0x52, 0xC3);     // pop edx; add edx, 2; push edx; ret: returns 2 bytes late
    l.o = LEAF_OFF + 0x1C0;
    F.andesp = l.here();
    l.emit(0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0);     // push ebp; mov ebp, esp; and esp, -16
    l.emit(0x83, 0xEC, 0x10, 0x89, 0x04, 0x24);     // sub esp, 16; mov [esp], eax
    l.emit(0x03, 0x04, 0x24, 0x8B, 0xE5, 0x5D, 0xC3); // add eax, [esp]; mov esp, ebp; pop ebp; ret

    const p = asm(buf, PV_OFF);
    F.pv = p.here();
    p.emit(0xBA); p.u32(0x11); p.emit(0xC3);        // mov edx, imm; ret

    const m = asm(buf, MID_OFF);
    F.mid = m.here();
    m.emit(0x55, 0x8B, 0xEC, 0x53);                 // push ebp; mov ebp, esp; push ebx
    m.emit(0xFF, 0x75, 0x08); m.call(F.sum);        // push dword [ebp+8]; call sum
    m.emit(0x89, 0xC3);                             // mov ebx, eax
    m.emit(0x81, 0xFB); m.u32(0x40000000);          // cmp ebx, 0x40000000
    m.call(F.cfadd);                                // eax += 0x10 + CF
    m.emit(0xBB); m.u32(0x7FFFFFFF);                // mov ebx, 0x7fffffff
    m.call(F.setcf);                                // flags of cmp eax, ebx
    m.emit(0x0F, 0x92, 0xC3, 0x0F, 0xB6, 0xDB, 0x01, 0xD8); // setb bl; movzx ebx, bl; add eax, ebx
    m.call(F.pv); m.emit(0x01, 0xD0);               // call pv; add eax, edx
    m.emit(0x5B, 0x5D, 0xC2, 0x04, 0x00);           // pop ebx; pop ebp; ret 4

    const o = asm(buf, OUTER_OFF);
    F.outer = o.here();
    o.emit(0x55, 0x8B, 0xEC, 0x51);                 // push ebp; mov ebp, esp; push ecx
    o.emit(0x8B, 0x45, 0x08, 0x83, 0xE0, 0x0F, 0x83, 0xC0, 0x05, 0x50); // mov eax, [ebp+8]; and eax, 15; add eax, 5; push eax
    o.call(F.mid); o.emit(0x01, 0xC7);              // call mid; add edi, eax
    o.emit(0x8B, 0x4D, 0x08);                       // mov ecx, [ebp+8]
    F.wrCall = o.here();
    o.o += 5;
    F.patch = o.here() + 1;
    o.emit(0xB8); o.u32(0x1234);                    // mov eax, imm: rewritten by wr
    o.emit(0x01, 0xC7);                             // add edi, eax
    o.call(F.andesp); o.emit(0x01, 0xC6);           // call andesp; add esi, eax
    o.call(F.retmod); o.emit(0x47, 0x47);           // call retmod; inc edi; inc edi (skipped)
    o.emit(0x59, 0x5D, 0xC2, 0x04, 0x00);           // pop ecx; pop ebp; ret 4

    l.o = LEAF_OFF + 0x200;
    F.wr = l.here();
    l.emit(0xF7, 0xC1); l.u32(0x1FFF);              // test ecx, 0x1fff
    l.emit(0x75, 0x06);                             // jnz done
    l.emit(0x89, 0x0D); l.u32(F.patch);             // mov [patch], ecx: the callee rewrites its caller
    l.emit(0xC3);                                   // done: ret
    const wc = asm(buf, F.wrCall - BASE);
    wc.call(F.wr);

    const r = asm(buf, REC_OFF);
    F.rec = r.here();
    r.emit(0x8B, 0x44, 0x24, 0x04, 0x85, 0xC0);     // mov eax, [esp+4]; test eax, eax
    r.emit(0x74, 0x0E, 0x48, 0x50);                 // jz base; dec eax; push eax
    r.call(F.rec);                                  // call rec
    r.emit(0x03, 0x44, 0x24, 0x04, 0xC2, 0x04, 0x00); // add eax, [esp+4]; ret 4
    r.emit(0xC2, 0x04, 0x00);                       // base: ret 4
    r.o = REC_OFF + 0x100;
    F.lng = r.here();
    r.emit(0x55, 0x8B, 0xEC, 0x53, 0x31, 0xDB, 0x8B, 0x4D, 0x08); // push ebp; mov ebp, esp; push ebx; xor ebx, ebx; mov ecx, [ebp+8]
    const ll = r.here();
    r.emit(0x51, 0x68); r.u32(LONG_N); r.call(F.sum); // l: push ecx; push LONG_N; call sum
    r.emit(0x01, 0xC3, 0x59, 0x49); r.jnz(ll);      // add ebx, eax; pop ecx; dec ecx; jnz l
    r.emit(0x89, 0xD8, 0x5B, 0x5D, 0xC2, 0x04, 0x00); // mov eax, ebx; pop ebx; pop ebp; ret 4

    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0x31, 0xFF, 0x31, 0xF6);                 // xor edi, edi; xor esi, esi
    const loop = n => {
        a.emit(0xB9); a.u32(n);
        const top = a.here();
        a.emit(0x51, 0x51); a.call(F.outer);        // push ecx; push ecx; call outer
        a.emit(0x59, 0x49); a.jnz(top);             // pop ecx; dec ecx; jnz
    };
    loop(ITER);
    a.out(1);
    a.emit(0xC7, 0x05); a.u32(F.pv + 1); a.u32(0x77); // mov dword [pv+1], 0x77
    loop(ITER2);
    a.out(2);
    a.emit(0xB9); a.u32(REC_ITER);
    const rt = a.here();
    a.emit(0x51, 0x6A, REC_N); a.call(F.rec);       // push ecx; push REC_N; call rec
    a.emit(0x01, 0xC7, 0x59, 0x49); a.jnz(rt);      // add edi, eax; pop ecx; dec ecx; jnz
    a.out(3);
    a.emit(0xB9); a.u32(LONG_CALLS);
    const lt = a.here();
    a.emit(0x51, 0x6A, LONG_K); a.call(F.lng);      // push ecx; push LONG_K; call lng
    a.emit(0x01, 0xC7, 0x59, 0x49); a.jnz(lt);      // add edi, eax; pop ecx; dec ecx; jnz
    a.out(4);
    a.emit(0xF4);
    return { buf, F };
}

function build_fault_image()
{
    const buf = new Uint8Array(IMAGE);
    header(new DataView(buf.buffer), BASE + ENTRY_OFF, BASE + IMAGE);
    pf_handler(buf);
    const F = {};
    const f = asm(buf, LEAF_OFF);
    F.rd = f.here();
    f.emit(0x8B, 0x44, 0x24, 0x04);                 // mov eax, [esp+4]
    F.load = f.here();
    f.emit(0x8B, 0x00, 0xC2, 0x04, 0x00);           // mov eax, [eax]; ret 4
    const o = asm(buf, MID_OFF);
    F.fo = o.here();
    o.emit(0x55, 0x8B, 0xEC, 0xFF, 0x75, 0x08);     // push ebp; mov ebp, esp; push dword [ebp+8]
    o.call(F.rd); o.emit(0x40, 0x5D, 0xC2, 0x04, 0x00); // call rd; inc eax; pop ebp; ret 4
    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0x31, 0xFF);                             // xor edi, edi
    a.emit(0xB9); a.u32(FAULT_ITER);
    const top = a.here();
    a.emit(0x51, 0x68); a.u32(BUF); a.call(F.fo);  // push ecx; push BUF; call fo
    a.emit(0x01, 0xC7, 0x59, 0x49); a.jnz(top);    // add edi, eax; pop ecx; dec ecx; jnz
    a.emit(0x68); a.u32(UNMAPPED); a.call(F.fo);   // push UNMAPPED; call fo: #PF two calls deep
    a.emit(0xC7, 0x05); a.u32(MARK); a.u32(0xBAD); // must not run
    a.emit(0xF4);
    return { buf, F };
}

const rol = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
function sum(n) { let a = 0; for(let c = n; c > 0; c--) { a = (a + c) >>> 0; a = rol(a, 3); } return a; }
function expected_main()
{
    let edi = 0, esi = 0, patch = 0x1234;
    for(const [n, pv] of [[ITER, 0x11], [ITER2, 0x77]])
        for(let c = n; c > 0; c--)
        {
            const s = sum((c & 15) + 5);
            let eax = (s + 0x10 + (s < 0x40000000 ? 1 : 0)) >>> 0;
            eax = (eax + (eax < 0x7FFFFFFF ? 1 : 0)) >>> 0;
            eax = (eax + pv) >>> 0;
            edi = (edi + eax) >>> 0;
            if((c & 0x1FFF) === 0) patch = c;
            edi = (edi + patch) >>> 0;
            esi = (esi + 2 * patch) >>> 0;
        }
    edi = (edi + REC_ITER * (REC_N * (REC_N + 1) / 2)) >>> 0;
    const lng = Math.imul(LONG_K, sum(LONG_N)) >>> 0;
    for(let i = 0; i < LONG_CALLS; i++) edi = (edi + lng) >>> 0;
    return { edi, esi };
}

function run(opts)
{
    if(process.env.UDBG) console.error("RUN", opts.name);
    return new Promise((resolve, reject) => {
        const { build, units = false, chain = 0, andEsp = false, toggle = false, mutation = 0, jit = true, onCheck } = opts;
        const emulator = new V86({ autostart: false, memory_size: MEM_SIZE, disable_jit: jit ? 0 : 1, log_level: 0 });
        const img = build();
        const modules = [];
        const checks = {};
        let timer, fp, freeInitial = 0;
        const finish = status => {
            clearTimeout(timer);
            try { emulator.stop(); } catch(e) {}
            delete globalThis.__jitPublicationCapture;
            const cpu = emulator.v86.cpu, w = cpu.wm.exports;
            const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            const out = {
                status, img, modules, fp, checks,
                stats: Array.from({ length: w.fn_unit_stat_count() }, (_, i) => w.fn_unit_stat(i)),
                counters: Array.from({ length: w.fn_unit_chain_counter_count() }, (_, i) => w.fn_unit_chain_counter(i) >>> 0),
                depth: w.fn_unit_chain_depth() >>> 0,
                count: w.fn_unit_count() >>> 0,
                counter: new Uint32Array(cpu.wasm_memory.buffer, 664, 1)[0],
                hook: w.fn_census_last_exception_counter() >>> 0,
                edi: cpu.reg32[7] >>> 0, esi: cpu.reg32[6] >>> 0, esp: cpu.reg32[4] >>> 0,
                mark: dv.getUint32(MARK, true),
                fnBytes: Array.from(cpu.mem8.subarray(BASE + FN_LO, BASE + FN_HI)),
            };
            const unitsBefore = out.count;
            w.fn_unit_set_enabled(0);
            out.countAfterOff = w.fn_unit_count() >>> 0;
            w.fn_unit_set_chain(0);
            w.fn_unit_set_and_esp(0);
            w.fn_unit_set_chain_counting(0);
            w.fn_unit_set_mutation(0);
            w.fn_unit_reset();
            w.fn_census_set_enabled(0);
            w.fn_census_reset();
            setTimeout(() => {
                cpu.jit_clear_cache();
                out.leak = { units: unitsBefore, free: w.jit_aot_free_table_index_count() >>> 0, initial: freeInitial,
                    pending: w.fn_unit_pending() >>> 0 };
                resolve(out);
            }, 100);
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            try {
                const cpu = emulator.v86.cpu, w = cpu.wm.exports;
                cpu.reboot_internal();
                cpu.reset_memory();
                const fp0 = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                const defaults = { units: w.fn_unit_enabled() >>> 0, chain: w.fn_unit_get_chain() >>> 0, andEsp: w.fn_unit_get_and_esp() >>> 0 };
                w.fn_unit_reset();
                w.fn_unit_set_mutation(mutation);
                w.fn_unit_set_threshold(4);
                w.fn_unit_set_chain_counting(1);
                w.fn_census_set_enabled(1);
                const fp1 = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                if(units || toggle) w.fn_unit_set_enabled(1);
                if(chain || toggle) w.fn_unit_set_chain(toggle ? 2 : chain);
                if(andEsp || toggle) w.fn_unit_set_and_esp(1);
                if(toggle)
                {
                    w.fn_unit_set_and_esp(0);
                    w.fn_unit_set_chain(0);
                    w.fn_unit_set_enabled(0);
                }
                fp = { before: fp0, census: fp1, after: [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0], defaults };
                w.jit_set_region_exclusion(BASE + FN_LO, BASE + FN_HI);
                globalThis.__jitPublicationCapture = {
                    begin(start, tableIndex) { modules.push({ start, tableIndex }); return null; },
                };
                cpu.jit_clear_cache?.();
                freeInitial = w.jit_aot_free_table_index_count() >>> 0;
                cpu.load_multiboot(img.buf.buffer);
                page_tables(cpu.mem8);
                cpu.io.register_write(CHECK_PORT, cpu, v => {
                    checks[v] = {
                        stats: Array.from({ length: w.fn_unit_stat_count() }, (_, i) => w.fn_unit_stat(i)),
                        counters: Array.from({ length: w.fn_unit_chain_counter_count() }, (_, i) => w.fn_unit_chain_counter(i) >>> 0),
                        counter: new Uint32Array(cpu.wasm_memory.buffer, 664, 1)[0],
                        extra: onCheck ? onCheck(v, cpu, w) : null,
                    };
                });
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
const F = build_main_image().F;
const slotsAt = (v, cpu, w) => Object.fromEntries(["outer", "mid", "sum", "cfadd", "setcf", "pv", "retmod", "wr", "andesp", "rec", "lng"]
    .map(k => [k, { slot: w.fn_unit_slot(F[k]) >>> 0, chain: w.fn_unit_chain_slot(F[k]) >>> 0 }]));

const interp = await run({ name: "interp", build: build_main_image, jit: false });
const off = await run({ name: "off", build: build_main_image });
const units = await run({ name: "units", build: build_main_image, units: true });
const canonical = await run({ name: "canonical", build: build_main_image, units: true, chain: 1, onCheck: slotsAt });
const priv = await run({ name: "private", build: build_main_image, units: true, chain: 2, mutation: MUTATION, onCheck: slotsAt });
const andEsp = await run({ name: "andEsp", build: build_main_image, units: true, chain: 2, andEsp: true, onCheck: slotsAt });
const offAfterOn = await run({ name: "offAfterOn", build: build_main_image, toggle: true });
const E = expected_main();
const arms = [["interpreter", interp], ["off", off], ["units", units], ["canonical", canonical], ["private", priv], ["andEsp", andEsp], ["offAfterOn", offAfterOn]];

for(const [name, r] of arms)
{
    if(r.status !== "halt") fail(`${name}: guest did not reach hlt (${r.status})`);
    if(r.fp.defaults.units || r.fp.defaults.chain || r.fp.defaults.andEsp) fail(`${name}: units, chain and and-esp must default OFF (${JSON.stringify(r.fp.defaults)})`);
    if(r.edi !== E.edi) fail(`${name}: checksum ${hex(r.edi)} != expected ${hex(E.edi)}`);
    if(r.esi !== E.esi) fail(`${name}: and-esp sum ${hex(r.esi)} != expected ${hex(E.esi)}`);
    if(r.esp !== STACK) fail(`${name}: esp ${hex(r.esp)} != ${hex(STACK)} at hlt`);
    if(r.mark !== 0) fail(`${name}: a fault reached the handler (${hex(r.mark)})`);
    if(r.counter !== interp.counter) fail(`${name}: retired ${r.counter} != interpreter ${interp.counter}`);
    for(const k of [1, 2, 3, 4])
        if(r.checks[k]?.counter !== interp.checks[k]?.counter) fail(`${name}: retired at check ${k} ${r.checks[k]?.counter} != interpreter ${interp.checks[k]?.counter}`);
    if(r.depth !== 0) fail(`${name}: chain depth ${r.depth} left behind`);
}
const fpEq = (x, y) => x[0] === y[0] && x[1] === y[1];
for(const [name, r] of arms.slice(1))
    if(!fpEq(r.fp.after, r.fp.census)) fail(`${name}: a unit switch moved the codegen fingerprint`);
for(const [name, r] of [["off", off], ["offAfterOn", offAfterOn], ["interpreter", interp]])
{
    if(r.stats.some(v => v !== 0)) fail(`${name}: unit stats moved while off: ${r.stats}`);
    if(r.counters.some(v => v !== 0)) fail(`${name}: chain counters moved while off: ${r.counters}`);
    if(r.count !== 0) fail(`${name}: units published while off`);
}
const ours = r => r.modules.filter(m => m.start >= BASE && m.start < BASE + IMAGE).map(m => m.start).join(",");
if(ours(off) !== ours(offAfterOn)) fail("page modules differ after enabling and disabling units, chain and and-esp");
if(units.counters.some(v => v !== 0)) fail(`units: chain counters moved with the chain off: ${units.counters}`);
if(units.stats[S.SITES] !== 0) fail("units: chain sites compiled with the chain off");

const phase = (r, k, from) => r.counters.map((v, i) => (r.checks[k]?.counters[i] ?? 0) - (from ? r.checks[from]?.counters[i] ?? 0 : 0));
for(const [name, r] of [["canonical", canonical], ["private", priv], ["andEsp", andEsp]])
{
    const st = r.stats, c = r.counters;
    const p1 = phase(r, 1), p2 = phase(r, 2, 1), p3 = phase(r, 3, 2), p4 = phase(r, 4, 3);
    if(st[S.FAILED] !== 0) fail(`${name}: a unit compile failed`);
    if(st[S.SITES] < 6) fail(`${name}: ${st[S.SITES]} chain sites compiled`);
    if(p2[C.CALLS] < ITER2 * 3) fail(`${name}: phase 2 made ${p2[C.CALLS]} chained calls after pv changed, want >= ${ITER2 * 3} (dependants recompiled)`);
    if(p2[C.FB_TOKEN] > 64) fail(`${name}: phase 2 fell back ${p2[C.FB_TOKEN]} times on a stale callee token`);
    if(st[S.DROPPED] < 2) fail(`${name}: ${st[S.DROPPED]} dependant units dropped; pv's change must drop mid and outer`);
    if(c[C.CALLER_TOKEN] < 2) fail(`${name}: ${c[C.CALLER_TOKEN]} caller-token exits; wr rewrites outer every 8192 calls`);
    if(c[C.RET_MISMATCH] < ITER2 / 2) fail(`${name}: ${c[C.RET_MISMATCH]} RET mismatches; retmod returns 2 bytes late on every call`);
    if(c[C.RET_MATCHED] < ITER2 * 4) fail(`${name}: ${c[C.RET_MATCHED]} matched RETs`);
    if(p3[C.FB_DEPTH] < REC_ITER / 4) fail(`${name}: phase 3 hit the depth cap ${p3[C.FB_DEPTH]} times, want >= ${REC_ITER / 2}`);
    if(p3[C.CALLS] < REC_ITER * 10) fail(`${name}: phase 3 made ${p3[C.CALLS]} chained self calls`);
    if(p4[C.CALLS] < LONG_K) fail(`${name}: phase 4 made ${p4[C.CALLS]} chained calls`);
    if(st[S.MAX_RETIRED] > 2 * LOOP_COUNTER + 4 * LONG_N + 64) fail(`${name}: one unit entry retired ${st[S.MAX_RETIRED]} instructions; the chain must share the loop budget`);
    if(st[S.MATCHED] + st[S.EXITED] !== st[S.ENTRIES]) fail(`${name}: matched + exited != entries`);
    if(r.countAfterOff !== 0) fail(`${name}: ${r.countAfterOff} units left after disabling`);
    const s = r.checks[2]?.extra ?? {};
    for(const k of ["outer", "mid", "sum", "cfadd", "setcf", "pv", "retmod", "wr"])
        if(!(s[k]?.slot < 0xFFFF && s[k]?.chain < 0xFFFF)) fail(`${name}: no chain unit for ${k} after phase 2 (${JSON.stringify(s[k])})`);
}
{
    const a = andEsp.checks[2]?.extra?.andesp, b = priv.checks[2]?.extra?.andesp;
    if(!(a?.slot < 0xFFFF)) fail(`andEsp: the and-esp frame was not admitted (${JSON.stringify(a)})`);
    if(b?.slot !== 0xFFFFFFFF) fail(`private: the and-esp frame was admitted without the option (${JSON.stringify(b)})`);
}
for(const [name, r] of [["canonical", canonical], ["private", priv], ["andEsp", andEsp], ["units", units]])
    if(r.fnBytes.some((b, i) => b !== off.fnBytes[i])) fail(`${name}: function bytes differ from the page-JIT arm`);

const faultInterp = await run({ name: "faultInterp", build: build_fault_image, jit: false });
const faultOff = await run({ name: "faultOff", build: build_fault_image });
const faultOn = await run({ name: "faultOn", build: build_fault_image, units: true, chain: 2, mutation: MUTATION });
const FF = faultOn.img.F;
for(const [name, r] of [["faultInterp", faultInterp], ["faultOff", faultOff], ["faultOn", faultOn]])
{
    if(r.status !== "halt") fail(`${name}: no halt (${r.status})`);
    if(r.mark !== FF.load) fail(`${name}: handler saw eip ${hex(r.mark)}, want the load at ${hex(FF.load)}`);
    if(r.hook !== faultInterp.hook) fail(`${name}: count at the exception hook ${r.hook} != interpreter ${faultInterp.hook}`);
}
if(faultOn.counter - faultInterp.counter !== faultOff.counter - faultInterp.counter) fail(`faultOn: after the fault the chain counts ${faultOn.counter - faultInterp.counter} more than the interpreter, the page JIT ${faultOff.counter - faultInterp.counter}`);
if(faultOn.counters[C.CALLS] < FAULT_ITER / 10) fail(`faultOn: ${faultOn.counters[C.CALLS]} chained calls before the fault`);
if(faultOn.counters[C.CALLEE_EXITED] < 1) fail("faultOn: the fault in the chained callee did not propagate EXITED to its caller");

for(const [name, r] of [["canonical", canonical], ["private", priv], ["andEsp", andEsp], ["units", units], ["faultOn", faultOn], ["off", off]])
    if(r.leak.free !== r.leak.initial || r.leak.pending !== 0) fail(`${name}: table slots ${r.leak.free} free after clear, ${r.leak.initial} before the run (pending ${hex(r.leak.pending)})`);

const sum4 = r => ({ entries: r.stats[S.ENTRIES], matched: r.stats[S.MATCHED], exited: r.stats[S.EXITED], published: r.stats[S.PUBLISHED],
    sites: r.stats[S.SITES], unchained: r.stats[S.UNCHAINED], dropped: r.stats[S.DROPPED], stalePublish: r.stats[S.STALE_PUBLISH],
    maxRetired: r.stats[S.MAX_RETIRED], counters: Object.fromEntries(Object.entries(C).map(([k, i]) => [k, r.counters[i]])) });
const report = {
    mutation: MUTATION, retired: interp.counter,
    units: sum4(units), canonical: sum4(canonical), private: sum4(priv), andEsp: sum4(andEsp),
    fault: { hook: faultOn.hook, interpreterHook: faultInterp.hook, after: faultOn.counter, interpreterAfter: faultInterp.counter, pageJitAfter: faultOff.counter, ...sum4(faultOn) },
    leaks: { private: priv.leak, fault: faultOn.leak },
};
if(process.env.UDBG) for(const k of [1, 2, 3, 4]) console.error("slots", k, JSON.stringify(priv.checks[k]?.extra), JSON.stringify(phase(priv, k, k > 1 ? k - 1 : 0)));
if(failures.length)
{
    console.error("jit-fn-unit-chain " + JSON.stringify(report));
    for(const f of failures) console.error("FAIL: " + f);
    process.exit(1);
}
console.log("jit-fn-unit-chain " + JSON.stringify(report));
process.exit(0);
