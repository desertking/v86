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

const BASE = 0x100000, ENTRY = 0x40, IMG = 0x8000, DONE = 0x9999, OUTER = 30000;
const PAGE_A = BASE + 0x1000, PAGE_B = BASE + 0x2000, PAGE_B2 = BASE + 0x3000;
const DATA = BASE + 0x5000, CHK = BASE + 0x6F00, CTR = BASE + 0x6F04, STACK_TOP = BASE + 0x6E00;
const PD = 0x300000, PT0 = 0x301000, PTE_B = PT0 + ((PAGE_B >>> 12) * 4);

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
    for (let i = 0; i < 1024; i++) dv.setUint32(DATA - BASE + 4 * i, R(1 << 30) * 4 + R(4), true);
    img.fill(0, CHK - BASE, CHK - BASE + 0x100);

    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0xBC, ...d32(STACK_TOP));
    emit(0xB8, ...d32(PT0 | 3)); emit(0xA3, ...d32(PD));
    emit(0xB8, ...d32(3)); emit(0xB9, ...d32(1024)); emit(0xBA, ...d32(PT0));
    const pt = o; emit(0x89, 0x02, 0x05, ...d32(0x1000), 0x83, 0xC2, 4, 0x49); emit(0x75, (pt - (o + 2)) & 255);
    emit(0xB8, ...d32(PD), 0x0F, 0x22, 0xD8, 0x0F, 0x20, 0xC0, 0x0D, ...d32(0x80000000), 0x0F, 0x22, 0xC0);
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    for (let r = 0; r < 8; r++) if (r !== 4 && r !== 6) emit(0xB8 + r, ...d32(R(1 << 30)));
    emit(0xBE, ...d32(DATA));
    const start = 0xF00 + R(0xE0);
    emit(0xE9, ...d32(PAGE_A + start - (BASE + o + 5)));

    const ops = [];
    const n = 24 + R(40);
    for (let i = 0; i < n; i++) {
        const k = R(10), a = [0, 1, 2, 3, 5, 7][R(6)], b = [0, 1, 2, 3, 5, 7][R(6)];
        if (k === 0) ops.push([0x01, 0xC0 | b << 3 | a]);
        else if (k === 1) ops.push([0x31, 0xC0 | b << 3 | a]);
        else if (k === 2) ops.push([0x81, 0xC0 | a, ...d32(R(1 << 30))]);
        else if (k === 3) ops.push([0x8B, 0x86 | a << 3, ...d32(4 * R(1024))]);
        else if (k === 4) ops.push([0x01, 0x86 | a << 3, ...d32(4 * R(1024))]);
        else if (k === 5) ops.push([0x8D, 0x84 | a << 3, 0x00 | b << 3 | a, ...d32(R(256))]);
        else if (k === 6) ops.push([0xC1, 0xC0 | a, 1 + R(31)]);
        else if (k === 7) ops.push([0x0F, 0xAF, 0xC0 | a << 3 | b]);
        else if (k === 8) ops.push([0x11, 0xC0 | b << 3 | a]);
        else ops.push([0x31, 0x05 | a << 3, ...d32(CHK), 0xD1, 0x05, ...d32(CHK)]);
    }
    const variant = ops.map(op => op[0] === 0x81 ? [0x81, op[1], ...d32(R(1 << 30))] : op);
    const head = [0xF7, 0x05, ...d32(CTR), ...d32(63), 0x75, 17, 0x81, 0x35, ...d32(PTE_B), ...d32(PAGE_B ^ PAGE_B2), 0x0F, 0x01, 0x3D, ...d32(PAGE_B)];
    const lay = (dst, list) => {
        let p = dst;
        for (const op of list) for (const v of op) img[p++ - BASE] = v;
        return p;
    };
    let p = PAGE_A + start;
    for (const v of head) img[p++ - BASE] = v;
    const splitAt = p;
    const fill = (from, list, skipTo) => {
        let q = from, i = 0;
        for (; i < list.length && q + list[i].length <= PAGE_B; i++) { for (const v of list[i]) img[q++ - BASE] = v; }
        return [q, i];
    };
    const [qa, ia] = fill(splitAt, ops);
    for (let q = qa; q < PAGE_B; q++) img[q - BASE] = 0x90;
    const tail = (dst, list) => {
        let q = lay(dst, list.slice(ia));
        const tailCode = [0x01, 0x05, ...d32(CHK), 0x01, 0x1D, ...d32(CHK), 0xD1, 0x05, ...d32(CHK), 0xFF, 0x0D, ...d32(CTR)];
        for (const v of tailCode) img[q++ - BASE] = v;
        const back = PAGE_A + start;
        img[q++ - BASE] = 0x0F; img[q++ - BASE] = 0x85;
        dv.setInt32(q - BASE, back - (q + 4), true); q += 4;
        for (const v of [0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE]) img[q++ - BASE] = v;
    };
    tail(PAGE_B, ops);
    tail(PAGE_B2, variant);
    return { img, start };
}

let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 60));
    else { console.error(e); process.exit(2); }
});
const SHIPPING_SWITCHES = ["jit_page_tails", "jit_guard_groups", "jit_ret_memo_inline", "jit_fwait_inline",
    "jit_multi_entry_loop_safety", "jit_sse_scalar_inline", "jit_x87_lean", "fpu_fld80_exact_fast", "jit_x87_runs",
    "jit_carry8_inline", "jit_sse_convert_inline"];
let moduleFailures = 0;
for (const k of ["log", "error", "warn"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { if (a.some(x => String(x).includes("JIT module failed"))) moduleFailures++; orig(...a); };
}

function run(img, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const b = emulator.read_memory(CHK, 4);
            resolve({ status, chk: (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, regs: Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0),
                reentries: cfg.stats ? w.profiler_dispatch_stat_get(3) : null });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1], [4, cfg.chain ? 1 : 0]]) cpu.set_jit_config(i, v);
                for (const n of SHIPPING_SWITCHES) w["set_" + n]?.(1);
                if (!w.set_jit_page_fallthrough) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_page_fallthrough(cfg.on ? 1 : 0);
                if (cfg.stats) w.set_dispatch_stats(1);
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
let failures = 0, offEntries = 0, onEntries = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const { img, start } = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+chain", { jit: true, on: true, chain: true }],
        ["off+stats", { jit: true, on: false, stats: true }], ["on+stats", { jit: true, on: true, stats: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_page_fallthrough`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    if (interp.status !== "done" || bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE\n  interp ${sig(interp)}`);
        for (const [nm, r] of res) console.error(`  ${nm.padEnd(10)} ${sig(r)}`);
        continue;
    }
    const off = res.find(([n]) => n === "off+stats")[1].reentries, on = res.find(([n]) => n === "on+stats")[1].reentries;
    offEntries += off; onEntries += on;
    console.log(`seed ${seed}: ok (loop at +${start.toString(16)}, dynamic module exits off ${off} on ${on})`);
}
if (moduleFailures) { failures++; console.error(`FAIL: ${moduleFailures} generated module(s) did not compile`); }
if (!failures && onEntries * 10 > offEntries) { failures++; console.error(`FAIL: fall-through did not keep the loop in its module (dynamic exits off ${offEntries}, on ${onEntries})`); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log(`all seeds consistent (dynamic module exits off ${offEntries}, on ${onEntries})`);
process.exit(0);
