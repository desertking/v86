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
const EXPECT_DIVERGENCE = args.includes("--expect-divergence");

const BASE = 0x100000, ENTRY_OFF = 0x40;
const GDT = BASE + 0xA000, GDTR = GDT + 0x40, IDTR = GDT + 0x48, IDT = BASE + 0xA800;
const VARS = BASE + 0xB000, CHK = VARS, CTR = VARS + 4, PFC = VARS + 8;
const QP = BASE + 0x20000, DP = BASE + 0x22000;
const STACK_TOP = BASE + 0x30000, IMG_SIZE = 0x31000;
const PD = 0x300000, PT0 = 0x301000;
const pte = va => PT0 + (va >>> 12) * 4;
const OUTER = 3000, DONE_PORT = 0x9999;
const ARITH = 0x8D5;

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
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
const POOL = [EAX, ECX, EDX, EBX, EBP];

function buildImage(seed) {
    const rnd = mulberry32(seed), R = n => Math.floor(rnd() * n), pick = a => a[R(a.length)];
    const img = new Uint8Array(IMG_SIZE);
    for (let i = 0; i < IMG_SIZE; i++) img[i] = R(256);
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
    for (let i = 0; i < 0x40; i++) img[VARS - BASE + i] = 0;

    let o = 0;
    const labels = {}, fix = [];
    const at = off => { o = off; };
    const label = n => { labels[n] = BASE + o; };
    const b = (...x) => { for (const v of x.flat(3)) img[o++] = v & 255; };
    const rel32 = n => { fix.push({ at: o, to: n }); o += 4; };
    const abs = (reg, a) => [0x05 | reg << 3, ...d32(a)];
    const mem = (reg, base, disp) => [0x80 | reg << 3 | base, ...d32(disp)];
    const imm = () => pick([0, 1, 2, 0x7F, 0x80, 0xFF, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, R(2 ** 32) >>> 0, R(256), R(16)]);

    at(0x6000); label("pf");
    b(0x50);
    b(0x8B, 0x44, 0x24, 0x10);
    b(0x25, d32(ARITH));
    b(0x31, abs(EAX, CHK));
    b(0xD1, abs(0, CHK));
    b(0x0F, 0x20, 0xD0);
    b(0xC1, 0xE8, 12, 0xC1, 0xE0, 2, 0x05, d32(PT0));
    b(0x81, 0x08, d32(1));
    b(0x0F, 0x20, 0xD0, 0x0F, 0x01, 0x38);
    b(0xFF, abs(0, PFC));
    b(0x58, 0x83, 0xC4, 0x04, 0xCF);

    const producer = (d, s) => {
        const t = R(9);
        const alu = pick([0x01, 0x09, 0x21, 0x29, 0x31, 0x39]);
        if (t < 3) b(alu, 0xC0 | s << 3 | d);
        else if (t < 4) b(alu | 2, 0xC0 | d << 3 | s);
        else if (t < 5) b(0x83, 0xC0 | pick([0, 1, 4, 5, 6, 7]) << 3 | d, R(256));
        else if (t < 6) b(0x81, 0xC0 | pick([0, 1, 4, 5, 6, 7]) << 3 | d, d32(imm()));
        else if (t < 7) b(pick([0x05, 0x0D, 0x25, 0x2D, 0x35, 0x3D, 0xA9]), d32(imm()));
        else if (t < 8) b(0x85, 0xC0 | s << 3 | d);
        else b(0xF7, 0xC0 | d, d32(imm()));
    };
    const neutral = (protect) => {
        const free = POOL.filter(r => !protect.includes(r) || R(10) === 0);
        const r = free.length ? pick(free) : EAX;
        const disp = R(0xF00) & ~3, t = R(13);
        if (t < 5) b(0x8B, mem(r, ESI, disp));
        else if (t < 6) b(0x89, mem(pick(POOL), ESI, disp));
        else if (t < 7) b(0x8A, mem(R(8), ESI, disp));
        else if (t < 8) b(0x0F, pick([0xB6, 0xB7, 0xBE, 0xBF]), mem(r, ESI, disp));
        else if (t < 9) b(0xC7, mem(0, ESI, disp), d32(imm()));
        else if (t < 10) b(0x8B, mem(r, EDI, disp));
        else if (t < 11) b(0xB8 + r, d32(imm()));
        else if (t < 12) b(0x8D, mem(r, pick(POOL), R(64)));
        else b(0x66, 0x8B, mem(r, ESI, disp));
    };
    const overwriter = () => {
        const t = R(9), a = pick(POOL), c = pick(POOL), disp = R(0xF00) & ~3;
        if (t < 1) b(pick([0x01, 0x29, 0x39, 0x31, 0x21, 0x09]), 0xC0 | c << 3 | a);
        else if (t < 3) b(0x3B, mem(a, ESI, disp));
        else if (t < 4) b(0x03, mem(a, ESI, disp));
        else if (t < 5) b(0x85, mem(a, ESI, disp));
        else if (t < 6) b(0x83, mem(7, ESI, disp), R(256));
        else if (t < 7) b(0x2B, mem(a, EDI, disp));
        else if (t < 8) b(0x3B, mem(a, ESI, disp));
        else b(0x01, mem(a, ESI, disp));
    };
    const reader = () => {
        const t = R(7), a = pick(POOL), c = pick(POOL);
        if (t < 2) b(0x9C, 0x5A, 0x81, 0xE2, d32(ARITH), 0x31, abs(EDX, CHK));
        else if (t < 3) b(0x0F, 0x90 + R(16), 0xC0 | a, 0x0F, 0xB6, 0xC0 | a << 3 | a);
        else if (t < 4) b(pick([0x11, 0x19]), 0xC0 | c << 3 | a);
        else if (t < 5) b(0x0F, 0x40 + R(16), 0xC0 | a << 3 | c);
        else if (t < 6) b(0x9F, 0x31, abs(EAX, CHK));
        else b(0x70 + R(16), 3, 0x83, 0xF0 | a, R(256));
    };

    at(0x1000); label("routine");
    const units = 40 + R(16);
    for (let u = 0; u < units; u++) {
        b(0x50, 0x8B, abs(EAX, CTR), 0x3D, d32(1000 - u * 17 - R(9)), 0x75, 17);
        b(0x81, 0x25, d32(pte(QP)), d32(~1 >>> 0));
        b(0x0F, 0x01, 0x3D, d32(QP));
        b(0x58);
        const d = pick(POOL), s = pick(POOL);
        producer(d, s);
        const n = R(4);
        for (let i = 0; i < n; i++) neutral([d, s]);
        if (R(10)) overwriter();
        reader();
    }
    b(0xC3);

    at(ENTRY_OFF); label("entry");
    b(0xBC, d32(STACK_TOP));
    b(0x0F, 0x01, 0x15, d32(GDTR));
    b(0xEA); fix.push({ at: o, to: "reload", absolute: true }); o += 4; b(d16(0x08));
    label("reload");
    b(0x66, 0xB8, d16(0x10), 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0, 0x8E, 0xE0, 0x8E, 0xE8);
    b(0x0F, 0x01, 0x1D, d32(IDTR));
    b(0xB0, 0xFF, 0xE6, 0x21, 0xE6, 0xA1);
    b(0xB8, d32(PD), 0x0F, 0x22, 0xD8);
    b(0x0F, 0x20, 0xC0, 0x0D, d32(0x80000000), 0x0F, 0x22, 0xC0);
    for (const r of POOL) b(0xB8 + r, d32(R(2 ** 32)));
    b(0xBE, d32(QP), 0xBF, d32(DP));
    b(0xC7, abs(0, CTR), d32(OUTER));
    label("outer");
    b(0xE8); rel32("routine");
    for (const r of POOL) b(0x31, abs(r, CHK));
    b(0xD1, abs(0, CHK));
    b(0xFF, abs(1, CTR));
    b(0x0F, 0x85); rel32("outer");
    b(0x66, 0xBA, d16(DONE_PORT), 0xEE, 0xF4, 0xEB, 0xFE);

    for (const f of fix) {
        const t = labels[f.to];
        dv.setUint32(f.at, f.absolute ? t : t - (BASE + f.at + 4), true);
    }
    const g = IDT - BASE + 14 * 8, target = labels.pf;
    dv.setUint16(g, target & 0xFFFF, true); dv.setUint16(g + 2, 0x08, true);
    img[g + 4] = 0; img[g + 5] = 0x8E; dv.setUint16(g + 6, target >>> 16, true);
    return img;
}

const SHIPPING_SWITCHES = ["jit_page_tails", "jit_guard_groups", "jit_ret_memo_inline", "jit_fwait_inline",
    "jit_multi_entry_loop_safety", "jit_sse_scalar_inline", "jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs",
    "jit_carry8_inline", "jit_sse_convert_inline", "jit_page_fallthrough", "jit_fist64_inline", "jit_ftol_call_fusion",
    "jit_smc_exit", "jit_flag_carry_neutral", "jit_cond_skip", "jit_x87_entry_state", "jit_x87_cmp_lean",
    "jit_gg_through_runs", "jit_adc_cf_only"];
let moduleFailures = 0;
for (const k of ["log", "error", "warn"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { if (a.some(x => String(x).includes("JIT module failed"))) moduleFailures++; orig(...a); };
}
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
            const u32 = a => { const x = emulator.read_memory(a, 4); return (x[0] | x[1] << 8 | x[2] << 16 | x[3] << 24) >>> 0; };
            let h = 0x811C9DC5;
            for (const x of emulator.read_memory(QP, 0x1000)) h = Math.imul(h ^ x, 0x01000193);
            resolve({ status, chk: u32(CHK), pf: u32(PFC), mem: h >>> 0, regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0),
                compiled: w?.jit_flags_fault_mat_compiled ? w.jit_flags_fault_mat_compiled() : -1 });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1], [21, cfg.flagLocals ? 1 : 0]]) cpu.set_jit_config(i, v);
                for (const n of SHIPPING_SWITCHES) w["set_" + n]?.(1);
                w.set_jit_flag_locals_auto?.(cfg.auto ? 1 : 0);
                if (!w.set_jit_flags_fault_mat) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_flags_fault_mat(cfg.on ? 1 : 0);
                w.set_jit_loop_eip_lazy?.(cfg.on ? 1 : 0);
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(img.buffer);
            const wr32 = (pa, v) => cpu.mem8.set(d32(v), pa);
            wr32(PD, PT0 | 3); wr32(PD + 4, (PT0 + 0x1000) | 3);
            for (let i = 0; i < 2048; i++) wr32(PT0 + 4 * i, (i << 12) | 3);
            cpu.io.register_write(DONE_PORT, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 240000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

const sig = r => `${r.status} chk=${r.chk?.toString(16)} pf=${r.pf} mem=${r.mem?.toString(16)} regs=${r.regs?.map(x => x.toString(16)).join(",")}`;
let failures = 0, diverged = 0;
console.log(`engine ${ENGINE}${EXPECT_DIVERGENCE ? "  NEGATIVE CONTROL" : ""}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }],
        ["on+flaglocals", { jit: true, on: true, flagLocals: true }], ["on+auto", { jit: true, on: true, auto: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: no set_jit_flags_fault_mat`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    const offBad = bad.some(([n]) => n === "off");
    const deferred = res.find(([n]) => n === "on")[1].compiled;
    if (bad.length) {
        diverged++;
        if (!EXPECT_DIVERGENCE || offBad) failures++;
        console.error(`${EXPECT_DIVERGENCE && !offBad ? "seed" : "FAIL seed"} ${seed}: DIVERGENCE (pf=${interp.pf} deferred=${deferred})\n  interp        ${sig(interp)}`);
        for (const [nm, r] of res) console.error(`  ${nm.padEnd(13)} ${sig(r)}`);
    }
    else console.log(`seed ${seed}: ok (pf=${interp.pf} deferred=${deferred})`);
    if (!(interp.pf > 0)) { failures++; console.error(`FAIL seed ${seed}: no #PF taken`); }
    if (!EXPECT_DIVERGENCE && !(deferred > 0)) { failures++; console.error(`FAIL seed ${seed}: nothing deferred`); }
}
if (moduleFailures) { failures++; console.error(`FAIL: ${moduleFailures} generated module(s) did not compile`); }
if (EXPECT_DIVERGENCE && !diverged) { failures++; console.error("FAIL: negative control did not diverge in any seed"); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log(EXPECT_DIVERGENCE ? `negative control: ${diverged} seed(s) diverged` : "all seeds consistent");
process.exit(0);
