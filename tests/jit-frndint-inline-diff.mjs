#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--engine"));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "8", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000, ENTRY = 0x40, IMG = 0x9000;
const DATA = BASE + 0x6000, OUT = BASE + 0x7000, CHK = BASE + 0x7F00, CTR = BASE + 0x7F08;
const STACK_TOP = BASE + 0x8F00, DONE = 0x9999, OUTER = 30000;

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
    const sp = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.5000000000000001, 2.4999999999999996, 1e300, -1e300, 4503599627370495.5, 4503599627370497, 0, -0, Infinity, -Infinity, NaN, 123.456, -987.25, 1e-300];
    for (let i = 0; i < 64; i++) dv.setFloat64(DATA - BASE + 8 * i, R(3) ? sp[R(sp.length)] : (rnd() - 0.5) * 2 ** (R(60) - 10), true);
    for (let i = 0; i < 4; i++) dv.setUint16(DATA - BASE + 0x300 + 2 * i, 0x037F | i << 10, true);
    for (let i = 0; i < 0x100; i++) img[0x7F00 + i] = 0;

    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    const MEM = (r, disp) => [0x86 | r << 3, ...d32(disp)];
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x20, 0xE0, 0x0D, ...d32(0x600), 0x0F, 0x22, 0xE0);
    emit(0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xFB, 0x83, 0xC8, 0x02, 0x0F, 0x22, 0xC0);
    emit(0xBE, ...d32(DATA));
    for (let r = 0; r < 8; r++) emit(0x0F, 0x10, ...MEM(r, 16 * r));
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const loop = o;
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x07, 0xC1, 0xE0, 0x04, 0x8D, 0x34, 0x06);
    for (let r = 0; r < 8; r++) emit(0x0F, 0x10, ...MEM(r, 16 * r));
    emit(0xBE, ...d32(DATA));
    const flagsToChk = () => { emit(0x9C, 0x58, 0x25, ...d32(0x8D5), 0x31, 0x05, ...d32(CHK), 0xD1, 0x05, ...d32(CHK)); };
    const n = 30 + R(30);
    for (let i = 0; i < n; i++) {
        emit(0xD9, ...MEM(5, 0x300 + 2 * R(4)));
        emit(0xDD, ...MEM(0, 8 * R(64)));
        if (R(2)) emit(0xD9, 0xFC);
        if (R(3) === 0) emit(0xD9, 0xFC);
        const t = R(3);
        if (t === 0) emit(0xDD, ...MEM(3, 0x400 + 8 * R(64)));
        else if (t === 1) emit(0xDB, ...MEM(3, 0x400 + 4 * R(128)));
        else emit(0xDF, ...MEM(7, 0x400 + 8 * R(64)));
    }
    emit(0xD9, ...MEM(5, 0x300));
    for (let r = 0; r < 8; r++) emit(0x0F, 0x11, ...MEM(r, 0x800 + 16 * r));
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    for (let r = 0; r < 8; r++) emit(0x0F, 0x11, 0x05 | r << 3, ...d32(OUT + 16 * r));
    emit(0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE);
    return img;
}

let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 60));
    else { console.error(e); process.exit(2); }
});

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const hex = a => Buffer.from(emulator.read_memory(a.at, a.n)).toString("hex");
            resolve({ status, chk: hex({ at: CHK, n: 4 }), xmm: hex({ at: OUT, n: 128 }), data: hex({ at: DATA + 0x400, n: 0x400 }),
                      regs: Array.from({ length: 8 }, (_, i) => (cpu.reg32[i] >>> 0).toString(16)).join(",") });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; const w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1);
                if (cfg.flagLocals) cpu.set_jit_config(21, 1);
                for (const n of ["jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs", "jit_fist64_inline", "jit_x87_entry_state", "jit_x87_cmp_lean"]) w["set_" + n]?.(1);
                w.set_relaxed_fpu?.(1);
                if (!w.set_jit_frndint_inline) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_frndint_inline(cfg.on ? 1 : 0);
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(img.buffer);
            cpu.io.register_write(DONE, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 120000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

const sig = r => `${r.status} chk=${r.chk} regs=${r.regs} xmm=${r.xmm} data=${r.data}`;
let failures = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+flaglocals", { jit: true, on: true, flagLocals: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_frndint_inline`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE in ${bad.map(([n]) => n).join(",")}`);
        console.error(`  interp ${sig(interp).slice(0, 200)}`);
        for (const [n, r] of bad) console.error(`  ${n.padEnd(14)}${sig(r).slice(0, 200)}`);
    }
    else console.log(`seed ${seed}: ok (chk=${interp.chk})`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
