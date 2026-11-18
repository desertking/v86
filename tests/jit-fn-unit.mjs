#!/usr/bin/env node
// Function units (fn_unit.rs): default-off baseline oracle. An admitted M1 census row is
// compiled from its entry by the page JIT's emitter and entered by the dispatcher at the
// function start only. Canonical state at every boundary; MATCHED when the RET lands on the
// pushed return address, EXITED otherwise, and the dispatcher continues at the exact EIP.
//
// Fixture: the census fixture's protected-mode setup. Four small functions live on pages the
// caller's modules may not absorb (region exclusion), so every direct CALL reaches the
// dispatcher. Phase 1 calls them from a loop; the caller then patches one function (SMC) and
// runs phase 2, which also calls a function whose bytes are written while its unit compiles;
// phase 3 makes one call run long enough to leave by the loop budget several times. A second
// image takes a #PF inside a unit. Expected values are computed here, independently, and every
// arm is also compared with the interpreter and with the page JIT alone.
//
// Arms: interpreter, off (census only), on (census + units), offAfterOn (units enabled and
// disabled before the run), and the mutations (each must make this test fail; run with
// --mutation=N to see it).
//
//   node tests/jit-fn-unit.mjs [--mutation=bits]

const { V86 } = await import("../build/libv86.mjs");

const MUTATION = +(process.argv.find(a => a.startsWith("--mutation="))?.split("=")[1] ?? 0);

const BASE = 0x100000, ENTRY_OFF = 0x20, IMAGE = 0x8000;
const PD = 0x200000, PT0 = 0x201000, PT1 = 0x202000;
const STACK = 0x380000, BUF = 0x400000, RESULT = 0x401000, MARK = 0x401010, UNMAPPED = 0xA00000;
const GDT_OFF = 0xE00, GDTR_OFF = 0xE20, IDT_OFF = 0xE30, IDTR_OFF = 0xEB8;
const FN_LO = 0x2000, FN_HI = 0x7000, AHEAD_OFF = 0x2000, SMC_OFF = 0x4000, WDC_OFF = 0x5000, SELF_OFF = 0x6000, PF_OFF = 0x7000;
const CHECK_PORT = 0x5F0;
const ITER = 60000, ITER2 = 60000, FAULT_ITER = 1500000, SUM_N = 37, LONG_N = 300000, LONG_CALLS = 3;
const MEM_SIZE = 32 * 1024 * 1024, TIMEOUT_MS = 120000;
const S = { ENTRIES: 0, MATCHED: 1, EXITED: 2, COMPILES: 3, PUBLISHED: 4, WRITTEN: 5, FAILED: 6, INVALIDATED: 7,
    NOT_M1: 8, RET_FORM: 9, SHAPE: 10, STATE: 11, PHYS: 12, STALE_ROW: 13, BUSY: 14, SKIP_STACK: 15, SKIP_GEN: 16,
    SKIP_MAPPING: 17, SKIP_STATE: 18, INSNS: 19 };

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
    const f = asm(buf, 0x3000);
    F.sum = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0x8B, 0x4D, 0x08);     // push ebp; mov ebp, esp; mov ecx, [ebp+8]
    f.emit(0x31, 0xC0);                             // xor eax, eax
    const sl = f.here();
    f.emit(0x01, 0xC8, 0xC1, 0xC0, 0x03, 0x49);     // l: add eax, ecx; rol eax, 3; dec ecx
    f.emit(0x75, (sl - (f.here() + 2)) & 0xFF);     // jnz l
    f.emit(0x5D, 0xC2, 0x04, 0x00);                 // pop ebp; ret 4
    f.o = 0x3100;
    F.mem = f.here();
    f.emit(0x55, 0x8B, 0xEC, 0x53);                 // push ebp; mov ebp, esp; push ebx
    f.emit(0x8B, 0x55, 0x08, 0x8B, 0x4D, 0x0C);     // mov edx, [ebp+8]; mov ecx, [ebp+12]
    const ml = f.here();
    f.emit(0x89, 0xC8, 0x83, 0xE0, 0x3F);           // l: mov eax, ecx; and eax, 63
    f.emit(0x01, 0x0C, 0x82, 0x49);                 // add [edx+eax*4], ecx; dec ecx
    f.emit(0x75, (ml - (f.here() + 2)) & 0xFF);     // jnz l
    f.emit(0x5B, 0x5D, 0xC2, 0x08, 0x00);           // pop ebx; pop ebp; ret 8
    f.o = 0x3200;
    F.flags = f.here();
    f.emit(0x3D); f.u32(ITER / 2);                  // cmp eax, ITER/2
    f.emit(0xC3);                                   // ret
    F.smc = BASE + SMC_OFF;
    const s = asm(buf, SMC_OFF);
    s.emit(0xB8); s.u32(0x11); s.emit(0xC3);        // mov eax, 0x11; ret
    F.wdc = BASE + WDC_OFF + 0x10;
    const w = asm(buf, WDC_OFF + 0x10);
    w.emit(0xB8); w.u32(5); w.emit(0xC3);           // mov eax, 5; ret
    F.ahead = BASE + AHEAD_OFF;
    const ah = asm(buf, AHEAD_OFF);
    ah.emit(0xF7, 0xC1); ah.u32(0x1FFF);            // test ecx, 0x1FFF
    ah.emit(0x75, 0x06);                            // jnz load
    ah.emit(0x89, 0x0D); ah.u32(F.ahead + 15);      // mov [imm of the next instruction], ecx: the running unit rewrites code it is about to execute
    ah.emit(0xB8); ah.u32(0x5555);                  // load: mov eax, imm
    ah.emit(0xC3);                                  // ret
    F.self = BASE + SELF_OFF;
    const sm = asm(buf, SELF_OFF);
    sm.emit(0xB8); sm.u32(0x1234);                  // mov eax, imm: the value the previous call stored
    sm.emit(0xF7, 0xC1); sm.u32(0x3FF);            // test ecx, 0x3FF
    sm.emit(0x75, 0x06);                            // jnz done
    sm.emit(0x89, 0x0D); sm.u32(F.self + 1);        // mov [self+1], ecx: the running unit rewrites its own body
    sm.emit(0xC3);                                  // done: ret

    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0x31, 0xFF, 0x31, 0xF6);                 // xor edi, edi; xor esi, esi
    const body = (withWdc) => {
        const top = a.here();
        a.emit(0x51);                               // push ecx
        a.emit(0x6A, SUM_N); a.call(F.sum);         // push SUM_N; call sum
        a.emit(0x01, 0xC7);                         // add edi, eax
        a.emit(0x6A, 64, 0x68); a.u32(BUF); a.call(F.mem);   // push 64; push BUF; call mem
        a.emit(0x8B, 0x04, 0x24); a.call(F.flags);  // mov eax, [esp]; call flags
        a.emit(0x0F, 0x92, 0xC2, 0x0F, 0xB6, 0xD2, 0x01, 0xD6); // setb dl; movzx edx, dl; add esi, edx
        a.call(F.smc); a.emit(0x01, 0xC7);          // call smc; add edi, eax
        if(withWdc)
        {
            a.call(F.wdc); a.emit(0xA3); a.u32(RESULT);  // call wdc; mov [RESULT], eax
            a.emit(0x8B, 0x0C, 0x24); a.call(F.self); a.emit(0x01, 0xC7);  // mov ecx, [esp]; call self; add edi, eax
            a.emit(0x8B, 0x0C, 0x24); a.call(F.ahead); a.emit(0x01, 0xC7); // mov ecx, [esp]; call ahead; add edi, eax
        }
        a.emit(0x59, 0x49); a.jnz(top);             // pop ecx; dec ecx; jnz
    };
    a.emit(0xB9); a.u32(ITER);
    body(false);
    a.out(1);
    a.emit(0xC7, 0x05); a.u32(F.smc + 1); a.u32(0x77);   // mov dword [smc+1], 0x77
    a.emit(0xB9); a.u32(ITER2);
    body(true);
    a.out(2);
    a.emit(0xB9); a.u32(LONG_CALLS);
    const lt = a.here();
    a.emit(0x51, 0x68); a.u32(LONG_N); a.call(F.sum);    // push ecx; push LONG_N; call sum
    a.emit(0x01, 0xC7, 0x59, 0x49); a.jnz(lt);           // add edi, eax; pop ecx; dec ecx; jnz
    a.out(3);
    a.emit(0xF4);
    return { buf, F };
}

function build_fault_image()
{
    const buf = new Uint8Array(IMAGE);
    header(new DataView(buf.buffer), BASE + ENTRY_OFF, BASE + IMAGE);
    pf_handler(buf);
    const F = {};
    const f = asm(buf, 0x3000);
    F.rd = f.here();
    f.emit(0x8B, 0x44, 0x24, 0x04);                 // mov eax, [esp+4]
    F.load = f.here();
    f.emit(0x8B, 0x00, 0xC2, 0x04, 0x00);           // mov eax, [eax]; ret 4
    const a = asm(buf, ENTRY_OFF);
    prologue(buf, a);
    a.emit(0x31, 0xFF);                             // xor edi, edi
    a.emit(0xB9); a.u32(FAULT_ITER);
    const top = a.here();
    a.emit(0x51, 0x68); a.u32(BUF); a.call(F.rd);  // push ecx; push BUF; call rd
    a.emit(0x01, 0xC7, 0x59, 0x49); a.jnz(top);    // add edi, eax; pop ecx; dec ecx; jnz
    a.emit(0x68); a.u32(UNMAPPED); a.call(F.rd);   // push UNMAPPED; call rd: #PF inside the unit
    a.emit(0xC7, 0x05); a.u32(MARK); a.u32(0xBAD); // must not run
    a.emit(0xF4);
    return { buf, F };
}

const rol = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
function sum(n) { let a = 0; for(let c = n; c > 0; c--) { a = (a + c) >>> 0; a = rol(a, 3); } return a; }
function expected_main()
{
    let edi = 0, esi = 0, selfPrev = 0x1234, aheadPrev = 0x5555;
    const buf = new Array(64).fill(0);
    const s = sum(SUM_N);
    for(const [n, smc] of [[ITER, 0x11], [ITER2, 0x77]])
        for(let c = n; c > 0; c--)
        {
            edi = (edi + s) >>> 0;
            for(let i = 64; i > 0; i--) buf[i & 63] = (buf[i & 63] + i) >>> 0;
            esi += c < ITER / 2 ? 1 : 0;
            edi = (edi + smc) >>> 0;
            if(smc === 0x77)
            {
                edi = (edi + selfPrev) >>> 0;
                if((c & 0x3FF) === 0) selfPrev = c;
                if((c & 0x1FFF) === 0) aheadPrev = c;
                edi = (edi + aheadPrev) >>> 0;
            }
        }
    const l = sum(LONG_N);
    for(let i = 0; i < LONG_CALLS; i++) edi = (edi + l) >>> 0;
    return { edi, esi, buf };
}

function run(opts)
{ if(process.env.UDBG) console.error("RUN", opts.build.name, "units", opts.units, "jit", opts.jit); return run0(opts); }
function run0({ build, units, toggle, mutation = 0, jit = true, census = true, onCheck, writeDuringCompile })
{
    return new Promise((resolve, reject) => {
        const emulator = new V86({ autostart: false, memory_size: MEM_SIZE, disable_jit: jit ? 0 : 1, log_level: 0 });
        const img = build();
        const modules = [];
        const checks = {};
        let timer, fp, wrote = false, freeInitial = 0;
        const finish = status => {
            clearTimeout(timer);
            try { emulator.stop(); } catch(e) {}
            delete globalThis.__jitPublicationCapture;
            const cpu = emulator.v86.cpu, w = cpu.wm.exports;
            const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            const out = {
                status, img, modules, fp, checks, wrote,
                stats: Array.from({ length: w.fn_unit_stat_count() }, (_, i) => w.fn_unit_stat(i)),
                count: w.fn_unit_count() >>> 0,
                counter: new Uint32Array(cpu.wasm_memory.buffer, 664, 1)[0],
                hook: w.fn_census_last_exception_counter() >>> 0,
                edi: cpu.reg32[7] >>> 0, esi: cpu.reg32[6] >>> 0,
                buf: Array.from({ length: 64 }, (_, i) => dv.getUint32(BUF + i * 4, true)),
                result: dv.getUint32(RESULT, true), mark: dv.getUint32(MARK, true),
                fnBytes: Array.from(cpu.mem8.subarray(BASE + FN_LO, BASE + FN_HI)),
            };
            const unitsBefore = out.count;
            w.fn_unit_set_enabled(0);
            out.countAfterOff = w.fn_unit_count() >>> 0;
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
                const defaultOn = w.fn_unit_enabled() >>> 0;
                w.fn_unit_reset();
                w.fn_unit_set_mutation(mutation);
                w.fn_unit_set_threshold(4);
                if(census) w.fn_census_set_enabled(1);
                const fp1 = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                if(units || toggle) w.fn_unit_set_enabled(1);
                if(toggle) w.fn_unit_set_enabled(0);
                fp = { before: fp0, census: fp1, after: [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0], defaultOn };
                w.jit_set_region_exclusion(BASE + FN_LO, BASE + FN_HI);
                globalThis.__jitPublicationCapture = {
                    begin(start, tableIndex) {
                        modules.push({ start, tableIndex });
                        if(writeDuringCompile && !wrote && start === writeDuringCompile.at)
                        {
                            wrote = true;
                            queueMicrotask(() => cpu.write_blob(writeDuringCompile.bytes, writeDuringCompile.addr));
                        }
                        return null;
                    },
                };
                cpu.jit_clear_cache?.();
                freeInitial = w.jit_aot_free_table_index_count() >>> 0;
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

const F = build_main_image().F;
const slots = {};
const onCheck = (v, cpu, w) => {
    slots[v] = { sum: w.fn_unit_slot(F.sum) >>> 0, smc: w.fn_unit_slot(F.smc) >>> 0, wdc: w.fn_unit_slot(F.wdc) >>> 0,
        smcGen: w.fn_unit_generation(F.smc) >>> 0, stats: Array.from({ length: w.fn_unit_stat_count() }, (_, i) => w.fn_unit_stat(i)) };
    return true;
};
const wdc = { at: F.wdc, addr: F.wdc + 1, bytes: [6] };

const interp = await run({ build: build_main_image, jit: false, writeDuringCompile: wdc });
const off = await run({ build: build_main_image, units: false, writeDuringCompile: wdc });
const on = await run({ build: build_main_image, units: true, mutation: MUTATION, onCheck, writeDuringCompile: wdc });
const offAfterOn = await run({ build: build_main_image, units: false, toggle: true, writeDuringCompile: wdc });
const E = expected_main();

for(const [name, r] of [["interpreter", interp], ["off", off], ["on", on], ["offAfterOn", offAfterOn]])
{
    if(r.status !== "halt") fail(`${name}: guest did not reach hlt (${r.status})`);
    if(r.fp.defaultOn !== 0) fail(`${name}: units must default OFF`);
    if(r.edi !== E.edi) fail(`${name}: checksum ${hex(r.edi)} != expected ${hex(E.edi)}`);
    if(r.esi !== E.esi) fail(`${name}: flag count ${r.esi} != expected ${E.esi}`);
    if(r.buf.some((v, i) => v !== E.buf[i])) fail(`${name}: memory written by the unit differs from the expected buffer`);
    if(r.mark !== 0) fail(`${name}: a fault reached the handler (${hex(r.mark)})`);
    if(r.counter !== interp.counter) fail(`${name}: retired ${r.counter} != interpreter ${interp.counter}`);
}
const fpEq = (x, y) => x[0] === y[0] && x[1] === y[1];
for(const [name, r] of [["off", off], ["on", on], ["offAfterOn", offAfterOn]])
    if(!fpEq(r.fp.after, r.fp.census)) fail(`${name}: the unit switch moved the codegen fingerprint`);
for(const [name, r] of [["off", off], ["offAfterOn", offAfterOn], ["interpreter", interp]])
{
    if(r.stats.some(v => v !== 0)) fail(`${name}: unit stats moved while off: ${r.stats}`);
    if(r.count !== 0) fail(`${name}: units published while off`);
    if(r.wrote) fail(`${name}: a unit compile started while off`);
    if(r.result !== 5) fail(`${name}: wdc result ${r.result} != 5 (nothing rewrote it)`);
}
const ours = r => r.modules.filter(m => m.start >= BASE && m.start < BASE + IMAGE).map(m => m.start).join(",");
if(ours(off) !== ours(offAfterOn)) fail("page modules differ after enabling and disabling units");

const st = on.stats;
if(!on.wrote) fail("on: the write-during-compile hook never saw the wdc unit compile");
if(on.result !== 6) fail(`on: wdc returned ${on.result} after its bytes became 6 during the unit compile (stale unit)`);
if(st[S.WRITTEN] < 1) fail("on: no compile was refused for a write during compilation");
if(st[S.ENTRIES] < (ITER + ITER2) * 2) fail(`on: unit entries ${st[S.ENTRIES]} < ${(ITER + ITER2) * 2}`);
if(st[S.MATCHED] + st[S.EXITED] !== st[S.ENTRIES]) fail("on: matched + exited != entries");
if(st[S.EXITED] < LONG_CALLS + 1) fail(`on: ${st[S.EXITED]} exits: the ${LONG_CALLS} long calls leave by the loop budget, and a unit that writes code on its own page must leave through the active-code-write exit`);
if(st[S.PUBLISHED] < 5) fail(`on: ${st[S.PUBLISHED]} units published, want sum, mem, flags, smc twice, wdc`);
if(st[S.INVALIDATED] < 2) fail(`on: ${st[S.INVALIDATED]} invalidations; the caller's SMC write and the unit rewriting its own body must invalidate`);
if(st[S.NOT_M1] + st[S.RET_FORM] + st[S.SHAPE] + st[S.STATE] !== 0) fail(`on: admitted rows refused ${st.slice(8, 12)}`);
if(st[S.FAILED] !== 0) fail("on: a unit compile failed");
const s1 = slots[1] ?? {}, s2 = slots[2] ?? {};
if(s1.sum === 0xFFFFFFFF || s1.smc === 0xFFFFFFFF) fail(`on: no unit for sum/smc after phase 1 (${JSON.stringify(s1)})`);
if(s2.sum !== s1.sum) fail("on: the sum unit on an unwritten page was replaced by the SMC write");
if(!(s2.smcGen > s1.smcGen)) fail(`on: smc generation ${s1.smcGen} -> ${s2.smcGen} did not advance`);
if(s2.smc === 0xFFFFFFFF) fail("on: smc was not recompiled after the write");
{
    const unitSlots = new Set([s1.sum, s1.smc].filter(x => x !== 0xFFFFFFFF));
    const after = on.modules.slice(on.modules.findIndex(m => m.start === F.smc && m.tableIndex === s1.smc) + 1);
    if(!after.some(m => m.tableIndex === s1.smc)) fail("on: the freed smc slot was never reused");
    if(unitSlots.size !== 2) fail("on: sum and smc share a slot");
}
if(on.fnBytes.some((b, i) => b !== off.fnBytes[i] && BASE + FN_LO + i !== F.wdc + 1)) fail("on: function bytes differ from the page-JIT arm");

{
    let before = -1;
    const jd = await run({ build: build_main_image, units: true, mutation: MUTATION, writeDuringCompile: wdc,
        onCheck: (v, cpu, w) => { if(v === 1) { before = w.fn_unit_stat(S.ENTRIES); w.set_jit_config(0, 1); } return true; } });
    if(jd.status !== "halt" || jd.edi !== E.edi) fail(`jitOff: ${jd.status}, checksum ${hex(jd.edi)}`);
    if(!(before > 0)) fail("jitOff: no unit entries before the JIT was disabled");
    if(jd.stats[S.ENTRIES] !== before || jd.stats[S.COMPILES] > on.stats[S.COMPILES]) fail(`jitOff: ${jd.stats[S.ENTRIES] - before} unit entries after the JIT was disabled`);
}

const faultInterp = await run({ build: build_fault_image, jit: false });
const faultOff = await run({ build: build_fault_image, units: false });
const faultOn = await run({ build: build_fault_image, units: true, mutation: MUTATION });
const FF = faultOn.img.F;
for(const [name, r] of [["faultInterp", faultInterp], ["faultOff", faultOff], ["faultOn", faultOn]])
{
    if(r.status !== "halt") fail(`${name}: no halt (${r.status})`);
    if(r.mark !== FF.load) fail(`${name}: handler saw eip ${hex(r.mark)}, want the load at ${hex(FF.load)}`);
    if(r.hook !== faultInterp.hook) fail(`${name}: count at the exception hook ${r.hook} != interpreter ${faultInterp.hook}`);
}
if(faultOn.counter - faultInterp.counter !== 1) fail(`faultOn: after the fault the unit counts ${faultOn.counter - faultInterp.counter} more than the interpreter (pinned: 1, the RET after the faulting load in the same block, as the page JIT counts a faulting block)`);
if(faultOn.stats[S.EXITED] < 1 || faultOn.stats[S.ENTRIES] < FAULT_ITER / 10) fail(`faultOn: entries ${faultOn.stats[S.ENTRIES]}, exits ${faultOn.stats[S.EXITED]}`);

for(const [name, r] of [["on", on], ["faultOn", faultOn], ["off", off]])
{
    if(r.countAfterOff !== 0) fail(`${name}: ${r.countAfterOff} units left after disabling`);
    if(r.leak.free !== r.leak.initial || r.leak.pending !== 0) fail(`${name}: table slots ${r.leak.free} free after clear, ${r.leak.initial} before the run (pending ${hex(r.leak.pending)})`);
}

const report = {
    mutation: MUTATION,
    on: { entries: st[S.ENTRIES], matched: st[S.MATCHED], exited: st[S.EXITED], compiles: st[S.COMPILES], published: st[S.PUBLISHED],
        writtenDuringCompile: st[S.WRITTEN], invalidated: st[S.INVALIDATED], deferred: st[S.BUSY], unitInsns: st[S.INSNS], retired: on.counter },
    slots: { 1: { sum: slots[1]?.sum, smc: slots[1]?.smc }, 2: { sum: slots[2]?.sum, smc: slots[2]?.smc, smcGen: slots[2]?.smcGen } },
    leaks: { on: on.leak, fault: faultOn.leak },
    fault: { hook: faultOn.hook, interpreterHook: faultInterp.hook, after: faultOn.counter, interpreterAfter: faultInterp.counter, pageJitAfter: faultOff.counter, entries: faultOn.stats[S.ENTRIES], exited: faultOn.stats[S.EXITED], stats: faultOn.stats },
};
if(failures.length)
{
    console.error("jit-fn-unit " + JSON.stringify(report));
    for(const f of failures) console.error("FAIL: " + f);
    process.exit(1);
}
console.log("jit-fn-unit " + JSON.stringify(report));
process.exit(0);
