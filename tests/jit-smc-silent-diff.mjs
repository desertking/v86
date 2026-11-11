#!/usr/bin/env node
// Silent stores to code pages (set_jit_smc_silent): a loop patches the immediates of its own
// instructions every iteration through every write path (32/16/8-bit stores, 64-bit SSE store,
// REP MOVSD, REP STOSB, interpreter and JIT). Most iterations write the bytes that are already
// there; every 8192nd (--every) writes a value whose FIRST byte is unchanged, so a comparison that looks at
// fewer bytes than were written keeps stale code. The accumulators must match the interpreter.
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ENGINES = (opt("--engine") ?? path.join(__dirname, "../build/v86.wasm")).split(",").map(e => path.resolve(e));
const ITER = parseInt(opt("--iter") ?? "100000", 10);
const EVERY = parseInt(opt("--every") ?? "8192", 10) - 1;
const EXPECT_DIFF = args.includes("--expect-diff");

const BASE = 0x100000, CODE = BASE + 0x2000, ACC = BASE + 0x8000, VAL = BASE + 0x9000, PD = 0x300000, PT0 = 0x301000, DONE = 0x9999;
const d32 = v => { v >>>= 0; return [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24]; };

const SWITCHES = ["jit_page_tails", "jit_guard_groups", "jit_ret_memo_inline", "jit_fwait_inline", "jit_multi_entry_loop_safety",
    "jit_sse_scalar_inline", "jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs", "jit_carry8_inline", "jit_sse_convert_inline",
    "jit_page_fallthrough", "jit_fist64_inline", "jit_flag_locals_auto", "jit_ftol_call_fusion", "jit_smc_exit", "jit_flag_carry_neutral",
    "jit_cond_skip", "jit_x87_entry_state", "jit_x87_cmp_lean", "jit_gg_through_runs", "jit_adc_cf_only", "jit_incdec_cf_keep",
    "jit_loop_eip_lazy", "jit_flags_fault_mat", "jit_reg8_lean", "jit_smc_exit_local", "jit_adc8_cf_direct", "jit_pf_inline",
    "jit_sse_packed_inline", "jit_alu16_inline", "jit_fldcw_inline", "jit_mmx_inline", "jit_gg_member_inline_fallback",
    "jit_cvttps2pi_inline", "jit_frndint_inline", "jit_idiv_inline", "jit_fld80_inline", "fpu_fld80_relaxed", "jit_wbuf_bitmap",
    "jit_mmx_logic_inline", "jit_rmw_misc_inline", "jit_out_direct", "jit_budget0_exit", "jit_page_straddle", "jit_x87_run_tail",
    "jit_x87_run_guard_share"];

function build(only) {
    const img = new Uint8Array(0xA000).fill(0x90);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, FLAGS, true); dv.setUint32(8, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0xc, BASE, true); dv.setUint32(0x10, BASE, true); dv.setUint32(0x14, BASE + img.length, true);
    dv.setUint32(0x18, BASE + img.length, true); dv.setUint32(0x1c, BASE + 0x40, true);
    const CONST = VAL + 0x30;
    dv.setUint32(CONST - BASE, 0x11223344, true);
    let o = 0x40;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0xBC, ...d32(BASE + 0x7F00));
    emit(0xB8, ...d32(PT0 | 3)); emit(0xA3, ...d32(PD));
    emit(0xB8, ...d32(3)); emit(0xB9, ...d32(1024)); emit(0xBA, ...d32(PT0));
    const pt = o; emit(0x89, 0x02, 0x05, ...d32(0x1000), 0x83, 0xC2, 4, 0x49); emit(0x75, (pt - (o + 2)) & 255);
    emit(0xB8, ...d32(PD), 0x0F, 0x22, 0xD8, 0x0F, 0x20, 0xC0, 0x0D, ...d32(0x80000000), 0x0F, 0x22, 0xC0);
    emit(0x0F, 0x20, 0xE0, 0x0D, ...d32(0x600), 0x0F, 0x22, 0xE0);
    emit(0x0F, 0x20, 0xC0, 0x25, ...d32(~4 >>> 0), 0x0D, ...d32(2), 0x0F, 0x22, 0xC0);
    emit(0xFC);
    emit(0xBD, ...d32(0));
    emit(0xE9, ...d32(CODE - (BASE + o + 5)));

    o = CODE - BASE;
    const top = o;
    emit(0x89, 0xE8, 0x25, ...d32(EVERY), 0xBA, ...d32(0x11223344));
    emit(0x85, 0xC0, 0x75, 0x08);
    emit(0x89, 0xEA, 0xC1, 0xE2, 0x08, 0x83, 0xCA, 0x44);
    const patchStart = o;
    const sitesAt = [];
    for (let k = 0; k < 6; k++) { sitesAt.push(o + 6); emit(0x81, 0x05, ...d32(ACC + 4 * k), ...d32(0x11223344)); }
    emit(0x81, 0x05, ...d32(ACC + 0x40), ...d32(0x01010101 * 0x11));
    const stosSite = o - 4;
    const jmpAt = o;
    o = patchStart + 0x200;
    const writers = o;
    const src = k => { if (k === only) emit(0x89, 0xD0); else emit(0xA1, ...d32(CONST)); };
    src(0); emit(0xA3, ...d32(BASE + sitesAt[0]));
    src(1); emit(0x66, 0xA3, ...d32(BASE + sitesAt[1]));
    src(1); emit(0xC1, 0xE8, 0x10, 0x66, 0xA3, ...d32(BASE + sitesAt[1] + 2));
    for (let b = 0; b < 4; b++) { src(2); if (b) emit(0xC1, 0xE8, 8 * b); emit(0xA2, ...d32(BASE + sitesAt[2] + b)); }
    src(3); emit(0xA3, ...d32(VAL + 0x10));
    emit(0x8B, 0x1D, ...d32(BASE + sitesAt[3] + 4), 0x89, 0x1D, ...d32(VAL + 0x14));
    emit(0xF3, 0x0F, 0x7E, 0x05, ...d32(VAL + 0x10));
    emit(0x66, 0x0F, 0xD6, 0x05, ...d32(BASE + sitesAt[3]));
    src(4); emit(0xA3, ...d32(VAL + 0x20));
    emit(0xBE, ...d32(VAL + 0x20), 0xBF, ...d32(BASE + sitesAt[4]), 0xB9, ...d32(1), 0xF3, 0xA5);
    if (only === 6) emit(0x89, 0xE8, 0x25, ...d32(EVERY), 0xB0, 0x11, 0x75, 0x02, 0xB0, 0x22);
    else emit(0xB0, 0x11, 0x90, 0x90);
    emit(0xBF, ...d32(BASE + stosSite), 0xB9, ...d32(4), 0xF3, 0xAA);
    src(5); emit(0x89, 0x05, ...d32(BASE + sitesAt[5]));
    emit(0x45, 0x81, 0xFD, ...d32(ITER));
    emit(0x0F, 0x85, ...d32(top - (o + 6)));
    emit(0x66, 0xBA, DONE & 255, DONE >> 8, 0xEE, 0xF4, 0xEB, 0xFE);
    img[jmpAt] = 0xE9; dv.setInt32(jmpAt + 1, writers - (jmpAt + 5), true);
    if (o > 0x8000 - 0x40) throw new Error("image overflow");
    return img;
}

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, log_level: 0, wasm_path: cfg.engine, disable_jit: cfg.jit ? 0 : 1 });
        let timer;
        emulator.add_listener("emulator-loaded", () => {
            const cpu = emulator.v86.cpu, w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            w.set_relaxed_fpu?.(1);
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                for (const n of SWITCHES) w["set_" + n]?.(1);
                if (cfg.silent !== undefined) {
                    if (!w.set_jit_smc_silent) { resolve({ status: "NO-SWITCH" }); return; }
                    w.set_jit_smc_silent(cfg.silent);
                }
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(img.buffer);
            const finish = status => {
                clearTimeout(timer);
                try { emulator.stop(); } catch { }
                const acc = Buffer.from(emulator.read_memory(ACC, 0x44)).toString("hex");
                resolve({ status, acc, ic: cpu.instruction_counter[0] >>> 0, regs: Array.from(cpu.reg32, x => (x >>> 0).toString(16)).join(","),
                    skips: w.jit_smc_silent_skips?.() ?? -1, smc: w.jit_smc_exits?.() ?? -1 });
            };
            cpu.io.register_write(DONE, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 240000);
            emulator.run();
        });
    });
}

const sig = r => `${r.status} ic=${r.ic} acc=${r.acc} regs=${r.regs}`;
let failures = 0, uncovered = 0;
for (let only = 0; only <= 6; only++) {
    const img = build(only);
    const interp = await run(img, { engine: ENGINES[0], jit: false });
    if (interp.status !== "done") failures++;
    for (const engine of ENGINES) {
        for (const silent of [0, 1]) {
            const r = await run(img, { engine, jit: true, silent });
            const ok = sig(r) === sig(interp);
            console.log(`${ok ? "OK  " : "DIFF"} path=${only} ${path.basename(engine)} silent=${silent} skips=${r.skips} smcExits=${r.smc}`);
            if (!ok || r.status === "NO-SWITCH") failures++;
            if (silent && !(r.skips > ITER && r.smc > 0)) uncovered++;
        }
    }
}
if (EXPECT_DIFF) {
    console.log(failures ? "negative control detected" : "FAIL: negative control NOT detected");
    process.exit(failures ? 0 : 1);
}
if (uncovered) { console.error(`FAIL coverage: ${uncovered} silent arm(s) without skipped invalidations or without an SMC exit`); failures++; }
console.log(failures ? `${failures} failure(s)` : "all consistent");
process.exit(failures ? 1 : 0);
