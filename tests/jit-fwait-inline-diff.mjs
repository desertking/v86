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

const BASE = 0x100000, ENTRY = 0x40, HANDLER = 0x2000, GDT = 0x3000, GDTR = 0x3040, IDT = 0x3800;
const CWTAB = BASE + 0x7E00, DATA = BASE + 0x6000, OUT = BASE + 0x7000, CHK = BASE + 0x7F00, NMCNT = BASE + 0x7F04, CTR = BASE + 0x7F08;
const IMG = 0x9000, STACK_TOP = BASE + 0x8F00, DONE = 0x9999, OUTER = 20000;

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
    dv.setUint16(IDT + 7 * 8, h & 0xFFFF, true); dv.setUint16(IDT + 7 * 8 + 2, 0x08, true);
    img[IDT + 7 * 8 + 5] = 0x8E; dv.setUint16(IDT + 7 * 8 + 6, h >>> 16, true);
    for (let i = 0; i < 64; i++) dv.setFloat32(DATA - BASE + 4 * i, (rnd() - 0.5) * 8 + (i % 3 ? 1 : 0.25), true);
    for (let i = 0; i < 0x100; i++) img[0x7F00 + i] = 0;
    [0x37F, 0x7F, 0x27F, 0x7F].forEach((v, i) => dv.setUint16(0x7E00 + 2 * i, v, true));

    let o = HANDLER;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0xFF, 0x05, ...d32(NMCNT), 0x0F, 0x06, 0xCF);

    o = ENTRY;
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x01, 0x15, ...d32(BASE + GDTR));
    const far = o; emit(0xEA, 0, 0, 0, 0, ...d16(0x08)); dv.setUint32(far + 1, BASE + o, true);
    emit(0x66, 0xB8, ...d16(0x10), 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0);
    emit(0x0F, 0x01, 0x1D, ...d32(BASE + GDTR + 8));
    emit(0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xFB, 0x83, 0xC8, 0x02, 0x0F, 0x22, 0xC0);
    emit(0xDB, 0xE3);
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const loop = o;
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x03, 0xD9, 0x2C, 0x45, ...d32(CWTAB));
    const mem = (op, reg, a) => emit(op, 0x05 | reg << 3, ...d32(a));
    const FW = () => emit(0x9B);
    const setTs = () => {
        emit(0xF7, 0x05, ...d32(CTR), ...d32(127));
        emit(0x75, 20);
        emit(0x0F, 0x20, 0xC0, 0x83, 0xC8, 0x08, 0x0F, 0x22, 0xC0);
        emit(0x9B, 0x9B);
        emit(0x0F, 0x20, 0xC0, 0x31, 0x05, ...d32(CHK));
    };
    const n = 6 + R(6);
    for (let i = 0; i < n; i++) {
        mem(0xD9, 0, DATA + 4 * R(64)); if (R(2)) FW();
        const k = 1 + R(3);
        for (let j = 0; j < k; j++) { mem(0xD8, [0, 1, 4, 6][R(4)], DATA + 4 * R(64)); if (R(3)) FW(); }
        if (R(2)) { emit(0x8B, 0x05, ...d32(CTR)); emit(0x31, 0x05, ...d32(CHK)); FW(); }
        mem(0xD9, 3, OUT + 4 * i); FW();
        emit(0xA1, ...d32(OUT + 4 * i)); emit(0x31, 0x05, ...d32(CHK)); emit(0xD1, 0x05, ...d32(CHK));
        if (R(4) === 0 || i === n - 1) setTs();
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
            const rd = a => { const b = emulator.read_memory(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
            resolve({ status, ic: cpu.instruction_counter[0] >>> 0, chk: rd(CHK), nm: rd(NMCNT), regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0),
                      st: Array.from(emulator.read_memory(OUT, 64)).join(",") });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            w.set_relaxed_fpu?.(1);
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1);
                if (cfg.x87) cpu.set_jit_config(10, 1);
                if (!w.set_jit_fwait_inline) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_fwait_inline(cfg.on ? 1 : 0);
                w.set_jit_multi_entry_loop_safety?.(cfg.on ? 1 : 0);
                if (cfg.lean && !w.set_jit_x87_lean) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_x87_lean?.(cfg.lean ? 1 : 0);
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

const sig = r => `${r.status} chk=${r.chk.toString(16)} nm=${r.nm} regs=${r.regs.map(x => x.toString(16)).join(",")} out=${r.st}`;
let failures = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+x87locals", { jit: true, on: true, x87: true }], ["on+lean", { jit: true, on: true, lean: true }], ["lean", { jit: true, on: false, lean: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_fwait_inline`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE\n  interp ${sig(interp).slice(0, 160)}`);
        for (const [n, r] of res) console.error(`  ${n.padEnd(13)} ${sig(r).slice(0, 160)}`);
    }
    else console.log(`seed ${seed}: ok (nm faults=${interp.nm}, retired ${res.map(([n, r]) => n + "=" + r.ic).join(" ")} interp=${interp.ic})`);
    for (const [n, r] of res) if (r.ic < interp.ic * 0.98) { failures++; console.error(`FAIL seed ${seed}: ${n} retired ${r.ic} of ${interp.ic} — a compiled loop ran without counting/yielding`); }
    if (interp.nm === 0) { failures++; console.error(`FAIL seed ${seed}: no #NM taken — the fault path was not exercised`); }
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
