#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "10", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000, ENTRY = 0x40, DATA = BASE + 0x6000, CHK = BASE + 0x7F00, CTR = BASE + 0x7F04;
const IMG = 0x8000, STACK_TOP = BASE + 0x7E00, DONE = 0x9999, OUTER = 40000;

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
    for (let i = 0; i < 256; i++) img[DATA - BASE + i] = R(256);
    img.fill(0, 0x7F00, 0x8000);

    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0xBC, ...d32(STACK_TOP));
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    for (let r = 0; r < 8; r++) if (r !== 4) emit(0xB8 + r, ...d32(R(1 << 30) * 4 + R(4)));
    emit(0xBE, ...d32(DATA));
    const loop = o;
    const reg8 = () => { const r = R(8); return r === 4 || r === 5 || r === 6 ? r - 4 : r; };
    emit(0xF8, 0xB0, 0xFF, 0xB3, 0x01, 0x00, 0xD8, 0x49, 0x0F, 0x92, 0xC2, 0x0F, 0xB6, 0xD2, 0x01, 0x15, ...d32(CHK));
    emit(0xF8, 0xB0, 0xFF, 0xB3, 0x01, 0x00, 0xD8, 0xB1, 0x00, 0xB2, 0x00, 0x10, 0xD1, 0x49, 0x0F, 0x92, 0xC2, 0x0F, 0xB6, 0xD2, 0x01, 0x15, ...d32(CHK));
    const n = 20 + R(20);
    for (let i = 0; i < n; i++) {
        const k = R(16);
        const a = reg8(), b = reg8();
        const tail = () => {
            const t = R(6), c = [0, 1, 2, 3, 5, 7][R(6)];
            if (t === 0) emit(0x40 + c);
            else if (t === 1) emit(0x48 + c);
            else if (t === 2) emit(0xFE, 0xC0 | R(2) << 3 | reg8());
            else if (t === 3) emit(0x66, 0x40 + c);
            else if (t === 4) emit(0xFF, 0xC0 | R(2) << 3 | c);
            else emit(0x48 + c, 0x72, 0x00);
            const v = R(4);
            if (v === 0) emit(0x9C, 0x5A, 0x31, 0x15, ...d32(CHK), 0xD1, 0x05, ...d32(CHK));
            else if (v === 1) emit(0x10, 0xC0 | reg8() << 3 | reg8());
            else if (v === 2) emit(0x0F, 0x92, 0xC0 | reg8(), 0x0F, 0xB6, 0xD0 | reg8(), 0x31, 0x15, ...d32(CHK));
        };
        if (k < 3) { if (R(2)) emit([0x00, 0x28, 0x38][R(3)], 0xC0 | reg8() << 3 | reg8()); if (R(4)) emit(R(2) ? 0x10 : 0x18, 0xC0 | b << 3 | a); if (R(4)) tail(); }
        else if (k < 5) emit(R(2) ? 0x12 : 0x1A, 0xC0 | a << 3 | b);
        else if (k < 6) { emit(0x80, 0xC0 | (R(2) ? 2 : 3) << 3 | a, R(256)); if (R(2)) tail(); }
        else if (k < 7) emit(R(2) ? 0x14 : 0x1C, R(256));
        else if (k < 8) emit(R(2) ? 0x12 : 0x1A, 0x46 | a << 3, R(200));
        else if (k < 9) { emit(R(2) ? 0x10 : 0x18, 0x46 | a << 3, R(200)); if (R(2)) tail(); }
        else if (k < 10) emit([0xF8, 0xF9, 0xF5][R(3)]);
        else if (k < 11) emit([0x00, 0x28, 0x38, 0x20][R(4)], 0xC0 | b << 3 | a);
        else if (k < 12) emit(0xC0, 0xC0 | [4, 5, 0, 2][R(4)] << 3 | a, 1 + R(7));
        else if (k < 13) emit(0x0F, 0x90 + R(16), 0xC0 | a, 0x0F, 0xB6, 0xC0 | 2 << 3 | a, 0x31, 0x15, ...d32(CHK));
        else if (k < 14) emit(0x9C, 0x5A, 0x31, 0x15, ...d32(CHK), 0xD1, 0x05, ...d32(CHK));
        else if (k < 15) emit(0x72 + R(14), 2, 0xFE, 0xC0 | a);
        else emit(0x9F, 0x30, 0xE0 | a);
    }
    emit(0x9C, 0x5A, 0x31, 0x15, ...d32(CHK), 0xD1, 0x05, ...d32(CHK));
    for (let r = 0; r < 4; r++) emit(0x31, 0x05 | r << 3, ...d32(CHK));
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    emit(0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE);
    if (o >= 0x6000) throw new Error("code overflows into data");
    return img;
}

const SHIPPING_SWITCHES = ["jit_page_tails", "jit_guard_groups", "jit_ret_memo_inline", "jit_fwait_inline",
    "jit_multi_entry_loop_safety", "jit_sse_scalar_inline", "jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs",
    "jit_carry8_inline", "jit_page_fallthrough", "jit_smc_exit", "jit_flag_carry_neutral", "jit_cond_skip"];
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

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const b = emulator.read_memory(CHK, 4);
            resolve({ status, chk: (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0),
                flags: cpu.get_eflags ? cpu.get_eflags() >>> 0 : 0, ic: cpu.instruction_counter[0] >>> 0 });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1], [21, cfg.flagLocals ? 1 : 0]]) cpu.set_jit_config(i, v);
                for (const n of SHIPPING_SWITCHES) w["set_" + n]?.(1);
                if (!w.set_jit_adc_cf_only) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_adc_cf_only(cfg.on ? 1 : 0);
                w.set_jit_flag_locals_auto?.(cfg.auto ? 1 : 0);
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

const sig = r => `${r.status} chk=${r.chk.toString(16)} regs=${r.regs.map(x => x.toString(16)).join(",")}`;
let failures = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+flaglocals", { jit: true, on: true, flagLocals: true }], ["on+auto", { jit: true, on: true, auto: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_adc_cf_only`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    if (interp.status !== "done" || bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE\n  interp ${sig(interp)}`);
        for (const [nm, r] of res) console.error(`  ${nm.padEnd(13)} ${sig(r)}`);
    }
    else console.log(`seed ${seed}: ok (chk ${interp.chk.toString(16)})`);
}
if (moduleFailures) { failures++; console.error(`FAIL: ${moduleFailures} generated module(s) did not compile`); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
