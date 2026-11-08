#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "12", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");
const OUTER = parseInt(opt("--outer") ?? "4000", 10);

const BASE = 0x100000, ENTRY = 0x40, HANDLER = 0x5000, GDT = 0x3000, GDTR = 0x3040, IDT = 0x3800;
const DATA = BASE + 0x6000, CHK = BASE + 0x8F00, PFCNT = BASE + 0x8F04, CTR = BASE + 0x8F08;
const PAGE_B = BASE + 0x2000, P2 = BASE + 0xB000;
const IMG = 0xC000, STACK_TOP = BASE + 0x9F00, PD = 0x300000, PT0 = 0x301000, DONE = 0x9999;
const PTE_B = PT0 + (PAGE_B >>> 12) * 4;

function mulberry32(a) {
    return () => {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const d32 = v => { v >>>= 0; return [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24]; };
const d16 = v => [v & 255, v >> 8 & 255];

function buildImage(seed) {
    const rnd = mulberry32(seed), R = n => Math.floor(rnd() * n);
    const img = new Uint8Array(IMG).fill(0x90);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, FLAGS, true); dv.setUint32(8, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0xc, BASE, true); dv.setUint32(0x10, BASE, true); dv.setUint32(0x14, BASE + IMG, true);
    dv.setUint32(0x18, BASE + IMG, true); dv.setUint32(0x1c, BASE + ENTRY, true);
    [0, 0, 0xFFFF, 0x00CF9A00, 0xFFFF, 0x00CF9200].forEach((v, i) => dv.setUint32(GDT + 4 * i, v, true));
    dv.setUint16(GDTR, 23, true); dv.setUint32(GDTR + 2, BASE + GDT, true);
    dv.setUint16(GDTR + 8, 256 * 8 - 1, true); dv.setUint32(GDTR + 10, BASE + IDT, true);
    const h = BASE + HANDLER;
    dv.setUint16(IDT + 14 * 8, h & 0xFFFF, true); dv.setUint16(IDT + 14 * 8 + 2, 0x08, true);
    img[IDT + 14 * 8 + 5] = 0x8E; dv.setUint16(IDT + 14 * 8 + 6, h >>> 16, true);
    for (let i = 0; i < 256; i++) dv.setUint32(DATA - BASE + 4 * i, (R(1 << 30) * 4 + R(4)) >>> 0, true);
    img.fill(0, 0x8F00, 0x9000);

    let o = HANDLER;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0x50, 0x0F, 0x20, 0xD0, 0xC1, 0xE8, 0x0C, 0x83, 0x0C, 0x85, ...d32(PT0), 0x01);
    emit(0x0F, 0x20, 0xD0, 0x0F, 0x01, 0x38, 0xFF, 0x05, ...d32(PFCNT), 0x58, 0x83, 0xC4, 0x04, 0xCF);

    o = ENTRY;
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x01, 0x15, ...d32(BASE + GDTR));
    const far = o; emit(0xEA, 0, 0, 0, 0, ...d16(0x08)); dv.setUint32(far + 1, BASE + o, true);
    emit(0x66, 0xB8, ...d16(0x10), 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0);
    emit(0x0F, 0x01, 0x1D, ...d32(BASE + GDTR + 8));
    emit(0xB8, ...d32(PT0 | 3)); emit(0xA3, ...d32(PD));
    emit(0xB8, ...d32(3)); emit(0xB9, ...d32(1024)); emit(0xBA, ...d32(PT0));
    const pt = o; emit(0x89, 0x02, 0x05, ...d32(0x1000), 0x83, 0xC2, 4, 0x49); emit(0x75, (pt - (o + 2)) & 255);
    emit(0xB8, ...d32(PD), 0x0F, 0x22, 0xD8, 0x0F, 0x20, 0xC0, 0x0D, ...d32(0x80000000), 0x0F, 0x22, 0xC0);
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const regs = [0, 2, 3, 5, 6, 7];
    for (const r of regs) emit(0xB8 + r, ...d32(R(1 << 30) * 4 + R(4)));
    const loop = 0x1E00 + R(0x80);
    const jmp = o; emit(0xE9, ...d32(loop - (jmp + 5)));

    o = loop;
    const ev = (mask, value, ...body) => {
        emit(0xA1, ...d32(CTR), 0x83, 0xE0, mask, 0x83, 0xF8, value, 0x75, body.length);
        emit(...body);
    };
    const late = (mask, value, ...body) => {
        emit(0x81, 0x3D, ...d32(CTR), ...d32(OUTER >>> 1), 0x73, 13 + body.length);
        ev(mask, value, ...body);
    };
    emit(0x50);
    late(15, 5, 0xC7, 0x05, ...d32(PTE_B), ...d32(P2 | 3), 0x0F, 0x01, 0x3D, ...d32(PAGE_B));
    late(31, 9, 0x83, 0x25, ...d32(PTE_B), 0xFE, 0x0F, 0x01, 0x3D, ...d32(PAGE_B));
    const smcAt = o;
    ev(7, 3, 0x80, 0x35, 0, 0, 0, 0, 0x5A);
    emit(0x58);

    const straddles = [];
    const pick = () => regs[R(regs.length)];
    const insn = () => {
        const a = pick(), b = pick(), k = R(9);
        if (k === 0) return { b: [0xB8 + a, ...d32(R(1 << 30))], imm: true };
        if (k === 1) return { b: [0x81, 0xC0 | a, ...d32(R(1 << 30))], imm: true };
        if (k === 2) return { b: [0x69, 0xC0 | a << 3 | b, ...d32(1 + R(1 << 20))], imm: true };
        if (k === 3) return { b: [0x81, 0x05, ...d32(CHK + 0x10 + 4 * R(8)), ...d32(R(1 << 30))], imm: true };
        if (k === 4) return { b: [0x8D, 0x80 | a << 3 | b, ...d32(R(1 << 30))], imm: true };
        if (k === 5) return { b: [0x8B, 0x05 | a << 3, ...d32(DATA + 4 * R(256))], imm: false };
        if (k === 6) return { b: [0x31, 0xC0 | b << 3 | a], imm: false };
        if (k === 7) return { b: [0xC1, 0xC0 | a, 1 + R(31)], imm: false };
        return { b: [0x66, 0x81, 0xC0 | a, ...d16(R(65536))], imm: true };
    };
    while (o < 0x2000 + 0x20 + R(0x40)) {
        const { b, imm } = insn();
        if (o < 0x2000 && o + b.length > 0x2000) straddles.push({ at: o, len: b.length, imm });
        emit(...b);
    }
    emit(0x50);
    ev(15, 5, 0xC7, 0x05, ...d32(PTE_B), ...d32(PAGE_B | 3), 0x0F, 0x01, 0x3D, ...d32(PAGE_B));
    emit(0x58);
    for (const r of regs) emit(0x31, 0x05 | r << 3, ...d32(CHK), 0xD1, 0x05, ...d32(CHK));
    emit(0xFF, 0x0D, ...d32(CTR));
    const back = o; emit(0x0F, 0x85, ...d32(loop - (back + 6)));
    emit(0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE);
    if (o >= HANDLER) throw new Error("code overflows into the handler");

    const s = straddles[0];
    const tail = s && s.imm ? BASE + s.at + s.len - 1 : CHK + 0x40;
    dv.setUint32(smcAt + 13 + 2, tail, true);
    img.copyWithin(P2 - BASE, 0x2000, 0x3000);
    if (s && s.imm) img[P2 - BASE + s.at + s.len - 1 - 0x2000] ^= 0x33;
    return { img, straddle: s };
}

let moduleFailures = 0;
for (const k of ["log", "error", "warn"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { if (a.some(x => String(x).includes("JIT module failed"))) moduleFailures++; orig(...a); };
}
let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 60));
    else { console.error(e); process.exit(2); }
});

const SHIPPING_SWITCHES = ["jit_page_tails", "jit_guard_groups", "jit_ret_memo_inline", "jit_fwait_inline",
    "jit_multi_entry_loop_safety", "jit_sse_scalar_inline", "jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs",
    "jit_carry8_inline", "jit_sse_convert_inline", "jit_page_fallthrough", "jit_fist64_inline", "jit_ftol_call_fusion",
    "jit_smc_exit", "jit_flag_carry_neutral", "jit_cond_skip", "jit_x87_entry_state"];

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const rd = a => { const b = emulator.read_memory(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
            resolve({
                status, ic: cpu.instruction_counter[0] >>> 0, chk: rd(CHK), pf: rd(PFCNT),
                regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0),
                sums: Buffer.from(emulator.read_memory(CHK + 0x10, 32)).toString("hex"),
                compiled: w.jit_straddles_compiled ? w.jit_straddles_compiled() : -1,
            });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                for (const n of SHIPPING_SWITCHES) w["set_" + n]?.(1);
                if (cfg.gg === 0) w.set_jit_guard_groups(0);
                if (cfg.fall === 0) w.set_jit_page_fallthrough(0);
                if (!w.set_jit_page_straddle) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_page_straddle(cfg.on ? 1 : 0);
                w.set_jit_flag_locals_auto?.(cfg.auto ? 1 : 0);
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(img.buffer);
            cpu.io.register_write(DONE, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 180000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

const sig = r => `${r.status} chk=${r.chk.toString(16)} pf=${r.pf} regs=${r.regs.map(x => x.toString(16)).join(",")} sums=${r.sums}`;
let failures = 0, totalCompiled = 0, withStraddle = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const { img, straddle } = buildImage(seed);
    if (!straddle) { console.log(`seed ${seed}: no straddling instruction, skipped`); continue; }
    withStraddle++;
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on-gg", { jit: true, on: true, gg: 0 }],
        ["on-fall", { jit: true, on: true, fall: 0 }], ["on+auto", { jit: true, on: true, auto: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_page_straddle`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    const on = res.find(([n]) => n === "on")[1];
    totalCompiled += on.compiled;
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE (straddle at ${(BASE + straddle.at).toString(16)} len ${straddle.len})\n  interp ${sig(interp).slice(0, 160)}`);
        for (const [n, r] of res) console.error(`  ${n.padEnd(8)} ${sig(r).slice(0, 160)}`);
    }
    else console.log(`seed ${seed}: ok (straddle at ${(BASE + straddle.at).toString(16)} len ${straddle.len}${straddle.imm ? " imm" : ""}, pf=${interp.pf}, straddles compiled ${on.compiled})`);
    for (const [n, r] of res) if (r.ic < interp.ic * 0.98) { failures++; console.error(`FAIL seed ${seed}: ${n} retired ${r.ic} of ${interp.ic}`); }
    if (interp.pf === 0) { failures++; console.error(`FAIL seed ${seed}: no #PF taken — the fetch fault path was not exercised`); }
}
if (moduleFailures) { failures++; console.error(`FAIL: ${moduleFailures} generated module(s) did not compile`); }
if (withStraddle === 0 || totalCompiled === 0) { failures++; console.error(`FAIL coverage: ${withStraddle} seed(s) with a straddle, ${totalCompiled} straddling block(s) compiled`); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log(`all seeds consistent (straddling blocks compiled ${totalCompiled} over ${withStraddle} seed(s))`);
process.exit(0);
