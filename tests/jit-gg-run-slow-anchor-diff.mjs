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
const CHK = BASE + 0xB000, A = BASE + 0x20000, B = A + 0x1000;
const STACK_TOP = BASE + 0x30000, IMG_SIZE = 0x31000;
const PD = 0x300000, PT0 = 0x301000, DONE_PORT = 0x9999, ITER = 2000, NBASE = 0x400000;
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
    for (const [p, k] of [[A, 1], [B, 2]]) {
        for (let i = 0; i < 0x400; i++) w32(p + 4 * i, Math.imul(i + 1, 0x9E3779B1 * k) >>> 0);
        dv.setFloat32(p - BASE, k * 1.5, true);
        dv.setFloat32(p - BASE + 4, k * 0.25, true);
    }
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
    b(0xDB, 0xE3);
    b(0xBD, d32(20));
    const outer = o;
    b(0x0F, 0x20, 0xD8, 0x0F, 0x22, 0xD8);
    b(0xB9, d32(ITER));
    const top = o;
    b(0xF6, 0xC1, 0x01, 0x75, 18);
    b(0xBE, d32(A), 0x89, 0xCF, 0xC1, 0xE7, 0x0B, 0x81, 0xC7, d32(NBASE + 0x1000), 0xEB, 11);
    b(0xBE, d32(NBASE), 0x8D, 0xBE, d32(0x100));
    b(0xD9, mem(0, ESI, 0));
    b(0xD8, mem(0, ESI, 4));
    b(0xD9, mem(3, 7, 8));
    b(0x8B, mem(0, ESI, 12));
    b(0x01, 0x05, d32(CHK));
    b(0xD1, 0x05, d32(CHK));
    if (variant === "barrier") b(0x9B, 0xDB, 0xE2);
    b(0x49);
    b(0x0F, 0x85, d32(top - (o + 6)));
    b(0x4D, 0x0F, 0x85, d32(outer - (o + 7)));
    b(0x66, 0xBA, d16(DONE_PORT), 0xEE, 0xF4, 0xEB, 0xFE);
    return img;
}

const SHIPPING_SWITCHES = ["jit_page_tails", "jit_guard_groups", "jit_ret_memo_inline", "jit_fwait_inline",
    "jit_multi_entry_loop_safety", "jit_sse_scalar_inline", "jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs",
    "jit_carry8_inline", "jit_sse_convert_inline", "jit_page_fallthrough", "jit_fist64_inline", "jit_ftol_call_fusion",
    "jit_smc_exit", "jit_flag_carry_neutral", "jit_cond_skip", "jit_x87_entry_state", "jit_x87_cmp_lean",
    "jit_adc_cf_only", "jit_incdec_cf_keep"];
let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 80));
    else { console.error(e); process.exit(2); }
});

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const x = emulator.read_memory(CHK, 4);
            resolve({ status, chk: (x[0] | x[1] << 8 | x[2] << 16 | x[3] << 24) >>> 0,
                members: w?.get_jit_guard_group_stat ? w.get_jit_guard_group_stat(4) : -1,
                runs: w?.jit_x87_runs_compiled ? w.jit_x87_runs_compiled() : -1 });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                for (const n of SHIPPING_SWITCHES) w["set_" + n]?.(1);
                w.set_relaxed_fpu?.(1);
                if (!w.set_jit_gg_through_runs) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_gg_through_runs(cfg.on ? 1 : 0);
                w.set_jit_flag_locals_auto?.(1);
                w.jit_guard_group_stats_reset?.();
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(img.buffer);
            const wr32 = (pa, v) => cpu.mem8.set(d32(v), pa);
            wr32(PD, PT0 | 3); wr32(PD + 4, (PT0 + 0x1000) | 3);
            for (let i = 0; i < 2048; i++) wr32(PT0 + 4 * i, ((i << 12) + (i >= NBASE >>> 12 ? 0x800000 : 0)) | 3);
            for (let i = 2; i < 0x400; i++) wr32(NBASE + 0x800000 + 4 * i, Math.imul(i + 7, 0x85EBCA6B) >>> 0);
            wr32(NBASE + 0x800000, 0x3FC00000); wr32(NBASE + 0x800004, 0x3E800000);
            cpu.io.register_write(DONE_PORT, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 120000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

let failures = 0, diverged = 0;
console.log(`engine ${ENGINE}${EXPECT_DIVERGENCE ? "  NEGATIVE CONTROL" : ""}`);
for (const variant of ["plain", "barrier"]) {
    const img = buildImage(variant);
    const interp = await run(img, { jit: false });
    const off = await run(img, { jit: true, on: false });
    const on = await run(img, { jit: true, on: true });
    if (on.status === "NO-SWITCH") { failures++; console.error("FAIL: no set_jit_gg_through_runs"); break; }
    const line = r => `${r.status} chk=${r.chk.toString(16)} members=${r.members} runs=${r.runs}`;
    const bad = [off, on].some(r => r.status !== interp.status || r.chk !== interp.chk);
    if (off.status !== interp.status || off.chk !== interp.chk) { failures++; console.error(`FAIL ${variant}: through-runs OFF diverges`); }
    if (bad) diverged++;
    if (bad && !EXPECT_DIVERGENCE) failures++;
    console.log(`${variant}: ${bad ? "DIVERGENCE" : "ok"}\n  interp ${line(interp)}\n  off    ${line(off)}\n  on     ${line(on)}`);
    if (!(on.runs > 0)) { failures++; console.error(`FAIL ${variant}: no x87 run compiled`); }
}
if (EXPECT_DIVERGENCE && !diverged) { failures++; console.error("FAIL: negative control did not diverge"); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log(EXPECT_DIVERGENCE ? "negative control: divergence detected" : "all variants consistent");
process.exit(0);
