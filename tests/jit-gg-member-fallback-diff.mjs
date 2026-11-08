#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");
const EXPECT_DIVERGENCE = args.includes("--expect-divergence");

const BASE = 0x100000, ENTRY_OFF = 0x40;
const GDT = BASE + 0xA000, GDTR = GDT + 0x40;
const CHK = BASE + 0xB000, V = BASE + 0x20000, REMAP = 0x900000;
const STACK_TOP = BASE + 0x30000, IMG_SIZE = 0x31000;
const PD = 0x300000, PT0 = 0x301000, DONE_PORT = 0x9999, ITER = 200000;
const d32 = v => { v >>>= 0; return [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24]; };
const d16 = v => [v & 255, v >> 8 & 255];
const ESI = 6;

function buildImage(variant) {
    const img = new Uint8Array(IMG_SIZE).fill(0x90);
    const dv = new DataView(img.buffer);
    const w32 = (va, v) => dv.setUint32(va - BASE, v >>> 0, true);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true); dv.setUint32(0x04, FLAGS, true); dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true); dv.setUint32(0x10, BASE, true); dv.setUint32(0x14, BASE + IMG_SIZE, true);
    dv.setUint32(0x18, BASE + IMG_SIZE, true); dv.setUint32(0x1c, BASE + ENTRY_OFF, true);
    [0, 0, 0xFFFF, 0x00CF9A00, 0xFFFF, 0x00CF9200].forEach((v, i) => w32(GDT + 4 * i, v));
    dv.setUint16(GDTR - BASE, 23, true); w32(GDTR + 2, GDT);
    for (let i = 0; i < 0x800; i++) w32(V + 4 * i, Math.imul(i + 3, 0x9E3779B1) >>> 0);
    w32(CHK, 0);

    let o = ENTRY_OFF;
    const b = (...x) => { for (const v of x.flat(3)) img[o++] = v & 255; };
    const mem = (reg, base, disp) => [0x80 | reg << 3 | base, ...d32(disp)];
    b(0xBC, d32(STACK_TOP));
    b(0x0F, 0x01, 0x15, d32(GDTR));
    b(0xEA, d32(BASE + o + 7), d16(0x08));
    b(0x66, 0xB8, d16(0x10), 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0, 0x8E, 0xE0, 0x8E, 0xE8);
    b(0xB8, d32(PD), 0x0F, 0x22, 0xD8);
    b(0x0F, 0x20, 0xC0, 0x0D, d32(0x80000000), 0x0F, 0x22, 0xC0);
    b(0xB9, d32(ITER));
    const top = o;
    b(0x89, 0xCE, 0x83, 0xE6, 0x0F, 0x81, 0xC6, d32(V + 0xFE8));
    b(0x8B, mem(0, ESI, 0));
    b(0x03, mem(0, ESI, 8));
    b(0x03, mem(0, ESI, 0x10));
    b(0x03, mem(0, ESI, 0x16));
    b(0x89, mem(0, ESI, 0x20));
    b(0x01, 0x05, d32(CHK));
    b(0xD1, 0x05, d32(CHK));
    b(0x49);
    b(0x0F, 0x85, d32(top - (o + 6)));
    b(0x66, 0xBA, d16(DONE_PORT), 0xEE, 0xF4, 0xEB, 0xFE);
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
        let done = false, timer, cpu, w, slow = 0;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const x = emulator.read_memory(CHK, 4);
            let h = 0x811C9DC5;
            for (const v of emulator.read_memory(V, 0x2000)) h = Math.imul(h ^ v, 0x01000193);
            for (const v of emulator.read_memory(REMAP, 0x1000)) h = Math.imul(h ^ v, 0x01000193);
            resolve({ status, chk: (x[0] | x[1] << 8 | x[2] << 16 | x[3] << 24) >>> 0, mem: h >>> 0, slow,
                members: w?.get_jit_guard_group_stat ? w.get_jit_guard_group_stat(4) : -1 });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1);
                w.set_jit_guard_groups?.(1);
                w.jit_guard_group_stats_reset?.();
                if (!w.set_jit_gg_member_inline_fallback) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_gg_member_inline_fallback(cfg.on ? 1 : 0);
                cpu.jit_clear_cache?.();
                for (const n of ["safe_read32s_slow_jit", "safe_write32_slow_jit"]) {
                    const f = cpu.jit_imports[n];
                    cpu.jit_imports[n] = (...a) => { slow++; return f(...a); };
                }
            }
            cpu.load_multiboot(img.buffer);
            const wr32 = (pa, v) => cpu.mem8.set(d32(v), pa);
            wr32(PD, PT0 | 3); wr32(PD + 4, (PT0 + 0x1000) | 3);
            for (let i = 0; i < 2048; i++) wr32(PT0 + 4 * i, (i << 12) | 3);
            wr32(PT0 + ((V + 0x1000) >>> 12) * 4, REMAP | 3);
            for (let i = 0; i < 0x400; i++) wr32(REMAP + 4 * i, Math.imul(i + 11, 0x85EBCA6B) >>> 0);
            cpu.io.register_write(DONE_PORT, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 120000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

let failures = 0;
console.log(`engine ${ENGINE}${EXPECT_DIVERGENCE ? "  NEGATIVE CONTROL" : ""}`);
const img = buildImage("plain");
const interp = await run(img, { jit: false });
const off = await run(img, { jit: true, on: false });
const on = await run(img, { jit: true, on: true });
const line = r => `${r.status} chk=${r.chk?.toString(16)} mem=${r.mem?.toString(16)} slow=${r.slow} members=${r.members}`;
console.log(`  interp ${line(interp)}\n  off    ${line(off)}\n  on     ${line(on)}`);
if (on.status === "NO-SWITCH") { console.error("FAIL: no set_jit_gg_member_inline_fallback"); process.exit(1); }
const same = r => r.status === interp.status && r.chk === interp.chk && r.mem === interp.mem;
if (!same(off)) { failures++; console.error("FAIL: fallback OFF diverges"); }
if (EXPECT_DIVERGENCE) {
    if (same(on)) { failures++; console.error("FAIL: negative control did not diverge"); }
    else console.log("negative control: divergence detected");
}
else {
    if (!same(on)) { failures++; console.error("FAIL: fallback ON diverges"); }
    if (!(off.members > 0)) { failures++; console.error("FAIL: no guard-group member compiled"); }
    if (!(on.slow * 2 < off.slow)) { failures++; console.error(`FAIL: slow calls not reduced (${off.slow} -> ${on.slow})`); }
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
if (!EXPECT_DIVERGENCE) console.log("consistent; slow helper calls reduced");
process.exit(0);
