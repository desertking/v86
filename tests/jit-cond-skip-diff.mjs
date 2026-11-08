#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "8", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");
const OUTER = parseInt(opt("--outer") ?? "3000", 10);

const BASE = 0x100000, ENTRY = 0x40, HANDLER = 0x2000, GDT = 0x3000, GDTR = 0x3040, IDT = 0x3800;
const D1 = BASE + 0x6000, D2 = BASE + 0x7000, SAVE = BASE + 0x8000, M80 = BASE + 0x8200;
const CHK = BASE + 0x8F00, PFCNT = BASE + 0x8F04, CTR = BASE + 0x8F08, CWTAB = BASE + 0x8F10, NMCNT = BASE + 0x8F20, NMH = 0x2100;
const IMG = 0xA000, STACK_TOP = BASE + 0x9F00, PD = 0x300000, PT0 = 0x301000, DONE = 0x9999;
const D2_PTE = PT0 + ((D2 >>> 12) * 4);

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

let idioms = 0;
const NONAN = !args.includes("--nan");
const idiomAt = [];
const SWM = opt("--swmask") ? [0x25, ...d32(parseInt(opt("--swmask"), 16))] : [];
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
    const nh = BASE + NMH;
    dv.setUint16(IDT + 7 * 8, nh & 0xFFFF, true); dv.setUint16(IDT + 7 * 8 + 2, 0x08, true);
    img[IDT + 7 * 8 + 5] = 0x8E; dv.setUint16(IDT + 7 * 8 + 6, nh >>> 16, true);

    const special = NONAN ? [0, -0, 1, -1, 0.5, 3.25, 1e-40, 16777217, 0.1, -7.75] : [0, -0, 1, -1, 0.5, 3.25, 1e30, -1e-30, 1e-40, Infinity, -Infinity, NaN, 16777217, 0.1, 2 ** 100, -7.75];
    for (const base of [D1, D2]) {
        const o = base - BASE;
        for (let i = 0; i < 128; i++) dv.setFloat32(o + 4 * i, R(5) === 0 ? special[R(special.length)] : (rnd() - 0.5) * 2 ** (R(40) - 20), true);
        for (let i = 0; i < 64; i++) dv.setFloat64(o + 0x200 + 8 * i, R(5) === 0 ? special[R(special.length)] : (rnd() - 0.5) * 2 ** (R(80) - 40), true);
        for (let i = 0; i < 64; i++) dv.setInt32(o + 0x400 + 4 * i, R(3) === 0 ? R(9) - 4 : (R(2) ? 1 : -1) * R(1 << 30), true);
    }
    const f80 = (i, lo, hi, se) => {
        dv.setUint32(M80 - BASE + 16 * i, lo >>> 0, true);
        dv.setUint32(M80 - BASE + 16 * i + 4, hi >>> 0, true);
        dv.setUint16(M80 - BASE + 16 * i + 8, se, true);
    };
    const exact = (i, d) => {
        const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, d, true);
        const lo = b.getUint32(0, true), hi = b.getUint32(4, true);
        const e = (hi >>> 20 & 0x7FF) - 1023, sign = hi >>> 31;
        const m = (BigInt(hi & 0xFFFFF) << 32n | BigInt(lo)) << 11n | 1n << 63n;
        f80(i, Number(m & 0xFFFFFFFFn), Number(m >> 32n), sign << 15 | e + 16383);
    };
    exact(0, (rnd() - 0.5) * 2 ** (R(60) - 30));
    exact(1, -1.5);
    f80(2, 0, 0, R(2) << 15);
    f80(3, 0, 0x80000000, NONAN ? 0x3FFF : 0x7FFF | R(2) << 15);
    f80(4, 1 + R(1 << 20), 0x80000000 | R(1 << 30), 0x3FFF + R(20) - 10);
    f80(5, R(1 << 30), R(1 << 30), NONAN ? 0x3FFE : 0x7FFE);
    f80(6, R(1 << 30), 0x80000000 | R(1 << 30), 0x0001);
    exact(7, -(rnd() * 1e6));
    img.fill(0, 0x8F00, 0x9000);
    [0x037F, 0x027F, 0x007F, 0x0F7F].forEach((v, i) => dv.setUint16(CWTAB - BASE + 2 * i, v, true));

    let o = HANDLER;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0x50, 0x0F, 0x20, 0xD0, 0xC1, 0xE8, 0x0C, 0x83, 0x0C, 0x85, ...d32(PT0), 0x01);
    emit(0x0F, 0x20, 0xD0, 0x0F, 0x01, 0x38, 0xFF, 0x05, ...d32(PFCNT), 0x58, 0x83, 0xC4, 0x04, 0xCF);

    o = NMH;
    emit(0x0F, 0x06, 0xFF, 0x05, ...d32(NMCNT), 0x50, 0x8B, 0x44, 0x24, 0x04, 0x31, 0x05, ...d32(NMCNT + 4), 0xD1, 0x05, ...d32(NMCNT + 4), 0x58, 0xCF);

    o = ENTRY;
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x01, 0x15, ...d32(BASE + GDTR));
    const far = o; emit(0xEA, 0, 0, 0, 0, ...d16(0x08)); dv.setUint32(far + 1, BASE + o, true);
    emit(0x66, 0xB8, ...d16(0x10), 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0);
    emit(0x0F, 0x01, 0x1D, ...d32(BASE + GDTR + 8));
    emit(0xB8, ...d32(PT0 | 3)); emit(0xA3, ...d32(PD));
    emit(0xB8, ...d32(3)); emit(0xB9, ...d32(1024)); emit(0xBA, ...d32(PT0));
    const pt = o; emit(0x89, 0x02, 0x05, ...d32(0x1000), 0x83, 0xC2, 4, 0x49); emit(0x75, (pt - (o + 2)) & 255);
    emit(0xB8, ...d32(PD), 0x0F, 0x22, 0xD8, 0x0F, 0x20, 0xC0, 0x0D, ...d32(0x80000000), 0x83, 0xE0, 0xF3, 0x0F, 0x22, 0xC0);
    emit(0xDB, 0xE3);
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const loop = o;
    emit(0xBE, ...d32(D1), 0xBF, ...d32(D2), 0xBB, ...d32(D1), 0xB9, ...d32(R(16)));
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x03, 0xD9, 0x2C, 0x45, ...d32(CWTAB));
    emit(0xF7, 0x05, ...d32(CTR), ...d32(3)); emit(0x75, 17);
    emit(0x81, 0x25, ...d32(D2_PTE), ...d32(~1)); emit(0x0F, 0x01, 0x3D, ...d32(D2));
    emit(0xF7, 0x05, ...d32(CTR), ...d32(63)); emit(0x75, 2); emit(0xDB, 0xE3);
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x07, 0x83, 0xF8, 0x05, 0x75, 9);
    emit(0x0F, 0x20, 0xC0, 0x83, 0xC8, 0x0A, 0x0F, 0x22, 0xC0);

    emit(0xDD, 0xC7, 0xDD, 0xC6, 0xD9, 0x05, ...d32(D1 + 4 * R(64)), 0xD9, 0x05, ...d32(D1 + 4 * R(64)));
    emit(0xDE, 0xC9, 0xD9, 0x1D, ...d32(D1 + 0x800 + 4 * R(64)), 0xDF, 0xE0, ...SWM, 0x31, 0x05, ...d32(CHK));
    const mem = (reg, off) => {
        const k = R(4);
        if (k === 0) return [0x05 | reg << 3, ...d32((R(2) ? D1 : D2) + off)];
        if (k === 1) return [0x86 | reg << 3, ...d32(off)];
        if (k === 2) return [0x87 | reg << 3, ...d32(off)];
        return [0x84 | reg << 3, 0x8B, ...d32(off & ~0x3F)];
    };
    const f32 = () => R(120) * 4, f64 = () => 0x200 + R(60) * 8, i32 = () => 0x400 + R(60) * 4;
    const st32 = () => 0x800 + R(64) * 4, st64 = () => 0xA00 + R(64) * 8;
    const bin = [0, 1, 4, 5, 6, 7];
    let depth = 0;
    idioms = 0; idiomAt.length = 0;
    const body = 24 + R(24);
    for (let n = 0; n < body; n++) {
        const want = depth < 2 ? "push" : depth > 6 ? "pop" : ["push", "pop", "op", "op", "op"][R(5)];
        const roll = R(100);
        if (roll >= 82) {
            idioms++;
            const ts = R(4) === 0;
            const lead = R(3);
            if (ts) emit(0x0F, 0x20, 0xC0, 0x83, 0xC8, 0x08, 0x0F, 0x22, 0xC0);
            else if (lead === 0) emit(0xF6, 0x05, ...d32(CTR), 1 << R(3), 0x75, 0x00);
            const entry = !ts && R(4) === 0;
            let hole = -1;
            if (entry) { emit(0xF6, 0x05, ...d32(CTR), 1 << R(4), 0x75, 0x00); hole = o - 1; }
            const varying = ts || R(3) === 0;
            const src = varying ? CTR : R(2) ? D1 + i32() : D2 + i32();
            emit(0xA1, ...d32(src));
            const pushes = !ts && R(4) !== 0;
            if (pushes) {
                const scr = D1 + st32();
                emit(0xA3, ...d32(scr));
                if (R(2)) emit(0x89, 0xC2);
                emit(0xDB, 0x05, ...d32(scr));
                depth++;
            }
            const p = varying ? 6 : R(6);
            if (p === 6) emit(0xA8, 1 << R(3));
            else if (p === 0) emit(0x85, 0xC0);
            else if (p === 1) emit(0x83, 0xF8, R(256));
            else if (p === 2) emit(0x01, 0xC2);
            else if (p === 3) emit(0x48);
            else if (p === 4) emit(0x85, 0xC0, 0x8B, 0xD0);
            else emit(0x3B, 0x05, ...d32(D1 + i32()));
            idiomAt.push((ts ? "T" : "") + (BASE + o).toString(16));
            emit(varying ? 0x74 + R(2) : 0x70 + R(16), 6);
            const far = R(2) ? D1 : D2;
            if (R(2)) emit(0xD8, 0x05, ...d32(far + f32()));
            else emit(0xDC, 0x05, ...d32(far + f64()));
            if (hole >= 0) img[hole] = (o - (hole + 1)) & 255;
            if (ts || R(2)) emit(0xD8, ...mem(1, f32()));
            if (pushes && depth > 1 && R(2)) { emit(0xDE, 0xC1); depth--; }
            if (R(3) === 0) emit(0xDF, 0xE0, ...SWM, 0x31, 0x05, ...d32(CHK), 0x89, 0x05, ...d32(D1 + st32()));
            continue;
        }
        if (roll < 3) {
            for (let j = 0; j < 9 - Math.max(0, depth); j++) emit(0xD9, 0xEE);
            emit(0xD9, ...mem(0, f32()), 0xDD, ...mem(3, st64()));
            depth = 8;
            continue;
        }
        if (roll < 9) {
            const k = R(8);
            if (k === 0) { emit(0xD8, ...mem(3, f32())); depth--; }
            else if (k === 1) { emit(0xDF, 0xE0, ...SWM, 0x31, 0x05, ...d32(CHK)); }
            else if (k === 2) { emit(0xDB, ...mem(3, st32())); depth--; }
            else if (k === 3) { emit(0xDB, 0x2D, ...d32(M80 + 16 * R(8))); depth++; }
            else if (k === 4) { emit(0xDD, 0xC0 | R(8)); }
            else if (k === 5) { emit(0xD9, R(2) ? 0xF7 : 0xF6); }
            else if (k === 6) { emit(0x8B, 0x05, ...d32(D1 + st32()), 0x31, 0x05, ...d32(CHK), 0xD1, 0x05, ...d32(CHK)); }
            else { emit(0xD9, 0xC8 | R(8)); }
            continue;
        }
        if (want === "push") {
            const k = R(6);
            if (k === 0) emit(0xD9, ...mem(0, f32()));
            else if (k === 1) emit(0xDD, ...mem(0, f64()));
            else if (k === 2) emit(0xDB, ...mem(0, i32()));
            else if (k === 3) emit(0xD9, 0xC0 | R(Math.max(1, Math.min(8, depth))));
            else if (k === 4) emit(0xD9, R(2) ? 0xE8 : 0xEE);
            else if (R(2)) emit(0xDB, 0x2D, ...d32(M80 + 16 * R(8)));
            else emit(0xD9, ...mem(0, f32()));
            depth++;
            if (R(3) === 0) emit(0x9B);
        }
        else if (want === "pop") {
            const k = R(5);
            if (k === 0) emit(0xD9, ...mem(3, st32()));
            else if (k === 1) emit(0xDD, ...mem(3, st64()));
            else if (k === 2) emit(0xDD, 0xD8 | R(Math.max(1, Math.min(8, depth))));
            else emit(0xDE, 0xC0 | bin[R(6)] << 3 | 1 + R(Math.max(1, Math.min(7, depth - 1))));
            depth--;
            if (R(3) === 0) emit(0x9B);
        }
        else {
            const k = R(9);
            const sti = R(Math.max(1, Math.min(8, depth)));
            if (k === 0) emit(0xD8, ...mem(bin[R(6)], f32()));
            else if (k === 1) emit(0xDC, ...mem(bin[R(6)], f64()));
            else if (k === 2) emit(0xDA, ...mem(bin[R(6)], i32()));
            else if (k === 3) emit(0xD8, 0xC0 | bin[R(6)] << 3 | sti);
            else if (k === 4) emit(0xDC, 0xC0 | bin[R(6)] << 3 | sti);
            else if (k === 5) emit(0xD9, 0xC8 | sti);
            else if (k === 6) emit(0xD9, R(2) ? 0xE0 : 0xE1);
            else if (k === 7) emit(0xD9, ...mem(2, st32()));
            else if (R(2)) emit(0xDD, 0xD0 | sti);
            else emit(0xDD, ...mem(2, st64()));
            if (R(4) === 0) {
                const c = R(8);
                if (c === 0) { emit(0xD8, ...mem(2, f32())); }
                else if (c === 1) { emit(0xD8, ...mem(3, f32())); depth--; }
                else if (c === 2) { emit(0xDC, ...mem(R(2) ? 2 : 3, f64())); }
                else if (c === 3) { emit(0xDA, ...mem(2, i32())); }
                else if (c === 4) { emit(0xD8, 0xD0 | sti); }
                else if (c === 5) { emit(0xDE, 0xD9); depth -= 2; }
                else if (c === 6) { emit(0xDD, 0xE8 | sti); depth--; }
                else { emit(0xDA, 0xE9); depth -= 2; }
                if (R(2)) emit(0xDF, 0xE0, ...SWM, 0x31, 0x05, ...d32(CHK), 0xD1, 0x05, ...d32(CHK));
            }
        }
    }
    emit(0xDD, 0x35, ...d32(SAVE));
    emit(0x56, 0xBE, ...d32(SAVE), 0xB9, ...d32(27), 0x31, 0xD2);
    const hl = o;
    emit(0xAD, 0x83, 0xF9, 0x18, 0x7F, 0x05, 0x83, 0xF9, 0x15, 0x7D, 0x0D);
    emit(0x31, 0x05, ...d32(CHK), 0xC1, 0x05, ...d32(CHK), 0x05);
    emit(0xE2, (hl - (o + 2)) & 255);
    emit(0x5E);
    emit(0x66, 0x81, 0x0D, ...d32(SAVE + 4), ...d16(0x0200), 0xDD, 0x25, ...d32(SAVE));
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    emit(0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE);
    if (o >= HANDLER) throw new Error("code overflows into the handler");
    return img;
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
    "jit_smc_exit", "jit_flag_carry_neutral"];

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const rd = a => { const b = emulator.read_memory(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
            const hex = (a, n) => Buffer.from(emulator.read_memory(a, n)).toString("hex");
            const save = emulator.read_memory(SAVE, 108);
            resolve({
                status, ic: cpu.instruction_counter[0] >>> 0, chk: rd(CHK), pf: rd(PFCNT),
                regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0), nm: rd(NMCNT), nmeip: rd(NMCNT + 4),
                out: hex(D1 + 0x800, 0x400) + hex(D2 + 0x800, 0x400),
                save: Buffer.from(save.slice(0, 12)).toString("hex") + Buffer.from(save.slice(28)).toString("hex"),
                compiled: w.jit_cond_skips_compiled ? w.jit_cond_skips_compiled() : -1, runs: w.jit_x87_runs_compiled?.() ?? -1, modules: w.profiler_stat_get ? -1 : -1,
                fast: cfg.stats ? w.profiler_dispatch_stat_get(27) : null,
                slow: cfg.stats ? w.profiler_dispatch_stat_get(28) : null,
            });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            w.set_relaxed_fpu?.(opt("--strict") ? 0 : 1);
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1], [31, cfg.pc === 0 ? 0 : 1]]) cpu.set_jit_config(i, v);
                for (const n of SHIPPING_SWITCHES) w["set_" + n]?.(1);
                if (cfg.lean === 0) w.set_jit_x87_lean(0);
                if (cfg.runs === 0) w.set_jit_x87_runs(0);
                if (cfg.gg === 0) w.set_jit_guard_groups(0);
                if (!w.set_jit_cond_skip) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_cond_skip(cfg.on ? 1 : 0);
                w.set_jit_flag_locals_auto?.(cfg.auto ? 1 : 0);
                if (cfg.stats) w.set_dispatch_stats(1);
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

const sig = r => `${r.status} chk=${r.chk.toString(16)} pf=${r.pf} nm=${r.nm} nmeip=${r.nmeip} regs=${r.regs.map(x => x.toString(16)).join(",")} save=${r.save} out=${r.out}`;
let failures = 0, totalFast = 0, totalSlow = 0, totalCompiled = 0, stockDiffers = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    if (opt("--dump")) (await import("node:fs")).writeFileSync(opt("--dump"), img);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on-runs", { jit: true, on: true, runs: 0 }],
        ["on-lean", { jit: true, on: true, lean: 0 }], ["on-gg", { jit: true, on: true, gg: 0 }], ["on+auto", { jit: true, on: true, auto: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_cond_skip`); continue; }
    const off = res.find(([n]) => n === "off")[1];
    const reference = sig(off) === sig(interp) ? interp : off;
    if (reference === off) {
        stockDiffers++;
        console.log(`seed ${seed}: note — the stock JIT (skip off) already differs from the interpreter; the skip is judged against the stock JIT`);
    }
    const bad = res.filter(([, r]) => sig(r) !== sig(reference));
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE\n  interp ${sig(interp).slice(0, 200)}`);
        for (const [n, r] of res) console.error(`  ${n.padEnd(11)} ${sig(r).slice(0, 200)}`);
        for (const [n, r] of res) if (r.save !== interp.save) console.error(`  ${n.padEnd(11)} save diff ` + [...r.save].map((c, i) => c === interp.save[i] ? "." : c).join("") + "\n  interp      save      " + interp.save);
        for (const [n, r] of res) console.error(`  ${n.padEnd(11)} fields ` + ["chk", "pf", "nm", "save", "out"].filter(f => String(r[f]) !== String(interp[f])).join(",") + (r.regs.join() !== interp.regs.join() ? ",regs" : ""));
    }
    const on = res.find(([n]) => n === "on")[1];
    totalCompiled += on.compiled;
    if (args.includes("--sig")) for (const [n, r] of [["interp", interp], ...res]) console.log(`  ${n} ${sig(r).slice(0, 400)}`);
    if (!bad.length) console.log(`seed ${seed}: ok (pf=${interp.pf}, nm=${interp.nm}, skips compiled ${on.compiled} of ${idioms})` + (args.includes("--where") ? ` runs ${on.runs} at ` + idiomAt.join(",") : ""));
    for (const [n, r] of res) if (r.ic < interp.ic * 0.98) { failures++; console.error(`FAIL seed ${seed}: ${n} retired ${r.ic} of ${interp.ic}`); }
    if (interp.nm === 0) { failures++; console.error(`FAIL seed ${seed}: no #NM taken — the task-switch path was not exercised`); }
    if (interp.pf === 0) { failures++; console.error(`FAIL seed ${seed}: no #PF taken — the fault path was not exercised`); }
}
if (moduleFailures) { failures++; console.error(`FAIL: ${moduleFailures} generated module(s) did not compile`); }
if (totalCompiled === 0) { failures++; console.error("FAIL coverage: no conditional skip was compiled"); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log(`all seeds consistent (skips compiled ${totalCompiled}; stock JIT differed from the interpreter on ${stockDiffers} seed(s))`);
process.exit(0);
