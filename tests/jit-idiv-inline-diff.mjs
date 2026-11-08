#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "6", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000, ENTRY_OFF = 0x40;
const GDT = BASE + 0xA000, GDTR = GDT + 0x40, IDTR = GDT + 0x48, IDT = BASE + 0xA800;
const CHK = BASE + 0xB000, DEC = BASE + 0xB004, CTR = BASE + 0xB008, DATA = BASE + 0xC000;
const STACK_TOP = BASE + 0x30000, IMG_SIZE = 0x31000, DONE_PORT = 0x9999, OUTER = 20000;

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
    const img = new Uint8Array(IMG_SIZE).fill(0x90);
    const dv = new DataView(img.buffer);
    const w32 = (va, v) => dv.setUint32(va - BASE, v >>> 0, true);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true); dv.setUint32(0x04, FLAGS, true); dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true); dv.setUint32(0x10, BASE, true); dv.setUint32(0x14, BASE + IMG_SIZE, true);
    dv.setUint32(0x18, BASE + IMG_SIZE, true); dv.setUint32(0x1c, BASE + ENTRY_OFF, true);
    [0, 0, 0xFFFF, 0x00CF9A00, 0xFFFF, 0x00CF9200].forEach((v, i) => w32(GDT + 4 * i, v));
    dv.setUint16(GDTR - BASE, 23, true); w32(GDTR + 2, GDT);
    dv.setUint16(IDTR - BASE, 256 * 8 - 1, true); w32(IDTR + 2, IDT);
    for (let i = 0; i < 256 * 8; i++) img[IDT - BASE + i] = 0;
    const vals = [0, 1, -1, 2, -2, 3, 7, -7, 0x7FFFFFFF, -0x80000000, 0x10000, 12345, -98765];
    for (let i = 0; i < 64; i++) {
        let v = R(3) ? vals[R(vals.length)] : (R(2) ? 1 : -1) * R(2 ** 31);
        if (v === 0 || v === -1) v = 5;
        w32(DATA + 4 * i, v);
    }
    w32(CHK, 0); w32(DEC, 0);

    let o = 0x6000;
    const b = (...x) => { for (const v of x.flat(3)) img[o++] = v & 255; };
    const handler = BASE + o;
    b(0x83, 0x04, 0x24, 0x02);
    b(0xFF, 0x05, d32(DEC));
    b(0x31, 0x05, d32(CHK));
    b(0xCF);

    o = ENTRY_OFF;
    b(0xBC, d32(STACK_TOP));
    b(0x0F, 0x01, 0x15, d32(GDTR));
    b(0xEA, d32(BASE + o + 7), d16(0x08));
    b(0x66, 0xB8, d16(0x10), 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0, 0x8E, 0xE0, 0x8E, 0xE8);
    b(0x0F, 0x01, 0x1D, d32(IDTR));
    b(0xBE, d32(DATA));
    b(0xC7, 0x05, d32(CTR), d32(OUTER));
    const top = o;
    const n = 20 + R(20);
    const regs = [0, 1, 2, 3, 5, 7];
    const big = [0, 1, -1, 0x7FFFFFFF, -0x80000000, R(2 ** 32), 0x12345678, -5];
    for (let i = 0; i < n; i++) {
        const t = R(4);
        b(0xB8, d32(big[R(big.length)]));
        if (R(2)) b(0x99); else b(0xBA, d32(big[R(big.length)]));
        if (t === 0) {
            b(0xBB, d32(big[R(big.length)]));
            b(0xF7, 0xFB);
        }
        else if (t === 1) {
            b(0xB9, d32([0, -1, 1, 3, -3, 0x10000][R(6)]));
            b(0xF7, 0xF9);
        }
        else {
            b(0x99);
            b(0xF7, 0xBE, d32(4 * R(64)));
        }
        b(0x31, 0x05, d32(CHK), 0x31, 0x15, d32(CHK), 0xD1, 0x05, d32(CHK));
    }
    b(0xFF, 0x0D, d32(CTR));
    b(0x0F, 0x85, d32(top - (o + 6)));
    b(0x66, 0xBA, d16(DONE_PORT), 0xEE, 0xF4, 0xEB, 0xFE);
    dv.setUint16(IDT - BASE, handler & 0xFFFF, true); dv.setUint16(IDT - BASE + 2, 0x08, true);
    img[IDT - BASE + 5] = 0x8E; dv.setUint16(IDT - BASE + 6, handler >>> 16, true);
    return img;
}

let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 80));
    else { console.error(e); process.exit(2); }
});

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const u32 = a => { const x = emulator.read_memory(a, 4); return (x[0] | x[1] << 8 | x[2] << 16 | x[3] << 24) >>> 0; };
            resolve({ status, chk: u32(CHK), de: u32(DEC), regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0) });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; const w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1], [21, cfg.flagLocals ? 1 : 0]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1);
                if (!w.set_jit_idiv_inline) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_idiv_inline(cfg.on ? 1 : 0);
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(img.buffer);
            cpu.io.register_write(DONE_PORT, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 120000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

const sig = r => `${r.status} chk=${r.chk?.toString(16)} de=${r.de} regs=${r.regs?.map(x => x.toString(16)).join(",")}`;
let failures = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+flaglocals", { jit: true, on: true, flagLocals: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: no set_jit_idiv_inline`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    if (interp.status !== "done" || bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE\n  interp        ${sig(interp)}`);
        for (const [nm, r] of res) console.error(`  ${nm.padEnd(13)} ${sig(r)}`);
    }
    else console.log(`seed ${seed}: ok (de=${interp.de})`);
    if (!(interp.de > 0)) { failures++; console.error(`FAIL seed ${seed}: no #DE taken`); }
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
