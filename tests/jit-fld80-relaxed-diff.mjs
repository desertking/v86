#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--engine"));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "6", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000, ENTRY = 0x40, IMG = 0x9000;
const DATA = BASE + 0x5000, OUT = BASE + 0x7000, CTR = BASE + 0x7F08, CWTAB = BASE + 0x7E00;
const STACK_TOP = BASE + 0x8F00, DONE = 0x9999, OUTER = 40000;

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
    for (let i = 0; i < 64; i++) {
        const a = 0x5000 + 10 * i;
        const kind = R(10);
        let mant = (BigInt(Math.floor(rnd() * 2 ** 31)) << 33n) | (BigInt(Math.floor(rnd() * 2 ** 31)) << 2n) | BigInt(R(4));
        let se = 0x3FFF + R(40) - 20 | (R(2) << 15);
        if (kind === 0) { mant = 0n; se = R(2) << 15; }
        else if (kind === 1) { mant = 0xC000000000000000n | BigInt(R(1000)); se = 0x7FFF; }
        else if (kind === 2) { mant = 1n << 63n; se = 0x7FFF | (R(2) << 15); }
        else if (kind === 3) { mant = BigInt(R(1 << 20)); se = R(2) << 15; }
        else if (kind === 4) { se = 0x3FFF + 2000; }
        else mant |= 1n << 63n;
        dv.setBigUint64(a, mant, true); dv.setUint16(a + 8, se, true);
        dv.setFloat32(0x5800 + 4 * i, (rnd() - 0.5) * 16, true);
        dv.setFloat64(0x5C00 + 8 * i, (rnd() - 0.5) * 1e3, true);
    }
    [0x37F, 0x7F, 0x27F, 0x37F].forEach((v, i) => dv.setUint16(0x7E00 + 2 * i, v, true));

    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xFB, 0x83, 0xC8, 0x02, 0x0F, 0x22, 0xC0);
    emit(0xDB, 0xE3);
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const loop = o;
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x03, 0xD9, 0x2C, 0x45, ...d32(CWTAB));
    const n = 8 + R(8);
    for (let i = 0; i < n; i++) {
        emit(0xDB, 0x2D, ...d32(DATA + 10 * R(64)));
        if (i === 0 || R(3) === 0) { emit(0xDB, 0x3D, ...d32(OUT + 0x380 + 10 * (i & 7))); continue; }
        for (let j = 0; j < 1 + R(3); j++) {
            const k = R(3);
            if (k === 0) emit(0xD8, 0x05 | [0, 1, 4, 6][R(4)] << 3, ...d32(DATA + 0x800 + 4 * R(64)));
            else if (k === 1) emit(0xDC, 0x05 | [0, 1, 4, 6][R(4)] << 3, ...d32(DATA + 0xC00 + 8 * R(64)));
            else { emit(0xDB, 0x2D, ...d32(DATA + 10 * R(64))); emit(0xDE, [0xC1, 0xC9, 0xE9, 0xF9][R(4)]); }
        }
        const s = R(3);
        if (s === 0) emit(0xDB, 0x3D, ...d32(OUT + 10 * i));
        else if (s === 1) emit(0xDD, 0x1D, ...d32(OUT + 0x200 + 8 * i));
        else emit(0xD9, 0x1D, ...d32(OUT + 0x300 + 4 * i));
    }
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
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
        let done = false, timer, cpu, w;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            resolve({ status, out: Buffer.from(emulator.read_memory(OUT, 0x400)).toString("hex"),
                      sw: cpu.fpu_status_word?.[0], fallback: w.profiler_fpu_relaxed_fallback_get?.() ?? -1 });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            w.set_relaxed_fpu?.(1);
            if (!w.set_fpu_fld80_relaxed) { resolve({ status: "NO-SWITCH" }); return; }
            w.set_fpu_fld80_relaxed(cfg.on ? 1 : 0);
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1);
                w.set_fpu_relaxed_stats?.(1);
                if (cfg.top) w.set_jit_x87_top_local(1);
                if (cfg.lean) { w.set_jit_x87_lean?.(1); w.set_jit_fwait_inline?.(1); w.set_jit_multi_entry_loop_safety?.(1); }
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

let failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const r = {};
    for (const [name, cfg] of [["interp-off", { jit: false, on: false }], ["jit-off", { jit: true, on: false }],
                               ["interp-on", { jit: false, on: true }], ["jit-on", { jit: true, on: true }],
                               ["jit-on-lean", { jit: true, on: true, lean: true }], ["jit-on-top", { jit: true, on: true, lean: true, top: true }]]) r[name] = await run(img, cfg);
    if (Object.values(r).some(x => x.status === "NO-SWITCH")) { fail(`seed ${seed}: engine has no set_fpu_fld80_relaxed`); continue; }
    if (Object.values(r).some(x => x.status !== "done")) { fail(`seed ${seed}: ${Object.entries(r).map(([k, x]) => k + "=" + x.status).join(" ")}`); continue; }
    if (r["jit-off"].out !== r["interp-off"].out) fail(`seed ${seed}: switch off, JIT diverges from the interpreter`);
    if (r["jit-on"].out !== r["interp-on"].out) fail(`seed ${seed}: switch on, JIT diverges from the interpreter`);
    if (r["jit-on-top"].out !== r["interp-on"].out) fail(`seed ${seed}: switch on + lean + top, JIT diverges from the interpreter`);
    if (r["jit-on-lean"].out !== r["interp-on"].out) fail(`seed ${seed}: switch on + lean, JIT diverges from the interpreter`);
    if (r["interp-on"].out === r["interp-off"].out) fail(`seed ${seed}: switch on changed nothing — the feature was not exercised`);
    console.log(`seed ${seed}: checked`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
