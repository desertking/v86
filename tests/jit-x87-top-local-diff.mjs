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
const DATA = BASE + 0x6000, OUT = BASE + 0x7000, SAVE = BASE + 0x7400, CHK = BASE + 0x7F00, CTR = BASE + 0x7F08, CWTAB = BASE + 0x7E00;
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
    for (let i = 0; i < 64; i++) dv.setFloat32(0x6000 + 4 * i, (rnd() - 0.4) * 2 ** (R(12) - 4), true);
    [0x37F, 0x7F, 0x27F, 0x37F].forEach((v, i) => dv.setUint16(0x7E00 + 2 * i, v, true));

    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    const m32 = (op, reg) => emit(op, 0x05 | reg << 3, ...d32(DATA + 4 * R(64)));
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xFB, 0x83, 0xC8, 0x02, 0x0F, 0x22, 0xC0);
    emit(0xDB, 0xE3);
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const loop = o;
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x03, 0xD9, 0x2C, 0x45, ...d32(CWTAB));
    const st = () => R(8);
    const OPS = [
        () => emit(0xD9, 0xC0 + st()), () => m32(0xD9, 0), () => emit(0xD9, [0xEE, 0xE8, 0xEB][R(3)]),
        () => emit(0xD9, 0xC8 + st()), () => emit(0xDD, 0xD8 + st()), () => emit(0xDD, 0xD0 + st()),
        () => emit(0xDE, 0xC0 + st()), () => emit(0xD8, 0xC8 + st()), () => emit(0xDC, 0xC0 + st()),
        () => emit(0xDE, 0xD9), () => m32(0xD8, 3), () => emit(0xD9, 0xF7), () => emit(0xD9, 0xF6),
        () => emit(0xDD, 0xC0 + st()), () => emit(0xD9, 0xE0), () => emit(0xD9, 0xE1), () => emit(0xD9, 0xFA),
        () => emit(0xD9, 0xF2), () => emit(0xD9, 0xF1), () => emit(0xD9, 0xFB), () => emit(0xD9, 0xF4),
        () => m32(0xD9, 3), () => m32(0xDB, 0), () => m32(0xD8, [0, 1, 4, 5, 6, 7][R(6)]),
        () => emit(0xDF, 0xE0, 0x31, 0x05, ...d32(CHK), 0xD1, 0x05, ...d32(CHK)),
        () => emit(0x9B), () => emit(0xD9, 0xFC), () => emit(0xDB, 0xE8 + st()), () => emit(0xDF, 0xF0 + st()),
        () => { if (R(8) === 0) emit(0xDB, 0xE3); }, () => m32(0xD9, 2),
        () => emit(0x8B, 0x05, ...d32(CTR), 0x01, 0x05, ...d32(CHK)),
    ];
    const n = 25 + R(25);
    for (let i = 0; i < n; i++) OPS[R(OPS.length)]();
    emit(0xDF, 0xE0, 0x31, 0x05, ...d32(CHK), 0xD1, 0x05, ...d32(CHK));
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    emit(0xDD, 0x35, ...d32(SAVE));
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
            resolve({ status, save: Buffer.from(emulator.read_memory(SAVE, 108)).toString("hex"),
                      chk: Buffer.from(emulator.read_memory(CHK, 4)).toString("hex"),
                      regs: Array.from({ length: 8 }, (_, i) => (cpu.reg32[i] >>> 0).toString(16)).join(",") });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; const w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            w.set_relaxed_fpu?.(1);
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1);
                if (cfg.x87) cpu.set_jit_config(10, 1);
                if (cfg.top && !w.set_jit_x87_top_local) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_x87_top_local?.(cfg.top ? 1 : 0);
                w.set_jit_x87_lean?.(cfg.lean ? 1 : 0);
                w.set_jit_fwait_inline?.(cfg.lean ? 1 : 0);
                w.set_jit_multi_entry_loop_safety?.(cfg.lean ? 1 : 0);
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

const sig = r => `${r.status} chk=${r.chk} regs=${r.regs} save=${r.save}`;
let failures = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true }], ["lean", { jit: true, lean: true }], ["top", { jit: true, top: true }],
                  ["lean+top", { jit: true, lean: true, top: true }], ["top+x87locals", { jit: true, top: true, x87: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_x87_top_local`); continue; }
    const off = res[0][1];
    const bad = res.slice(1).filter(([, r]) => sig(r) !== sig(off));
    const note = sig(off) === sig(interp) ? "" : " (JIT with every switch off differs from the interpreter: pre-existing, not judged here)";
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE from the switch-off JIT in ${bad.map(([n]) => n).join(",")}`);
        console.error(`  off    ${sig(off).slice(0, 180)}`);
        for (const [n, r] of bad) console.error(`  ${n.padEnd(14)}${sig(r).slice(0, 180)}`);
    }
    else console.log(`seed ${seed}: ok (chk=${off.chk})${note}`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
