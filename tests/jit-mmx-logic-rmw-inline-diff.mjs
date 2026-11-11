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
const DATA = BASE + 0x6000, OUT = BASE + 0x7000, CHK = BASE + 0x7F00, CTR = BASE + 0x7F10;
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
    const specials32 = [0, 0x80000000, 0x7F800000, 0xFF800000, 0x7FC00000, 0xFFC00001, 0x00000001, 0x807FFFFF, 0x3F800000, 0xBF800000, 0x7F7FFFFF];
    for (let i = 0; i < 128; i++) {
        if (R(5) === 0) dv.setUint32(DATA - BASE + 4 * i, specials32[R(specials32.length)] >>> 0, true);
        else dv.setFloat32(DATA - BASE + 4 * i, (rnd() - 0.5) * 2 ** (R(40) - 20), true);
        if (R(6) === 0) dv.setFloat64(DATA - BASE + 8 * R(64), (rnd() - 0.5) * 2 ** (R(60) - 30), true);
    }
    for (let i = 0; i < 0x100; i++) img[0x7F00 + i] = 0;

    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    const MEM = (r, disp) => [0x86 | r << 3, ...d32(disp)];
    const GPR = [0, 1, 2, 3, 5, 7];
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x20, 0xE0, 0x0D, ...d32(0x600), 0x0F, 0x22, 0xE0);
    emit(0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xFB, 0x83, 0xC8, 0x02, 0x0F, 0x22, 0xC0);
    emit(0xBE, ...d32(DATA));
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    const loop = o;
    emit(0xA1, ...d32(CTR), 0x83, 0xE0, 0x07, 0xC1, 0xE0, 0x03, 0x8D, 0x34, 0x06);
    for (let r = 0; r < 8; r++) emit(0x0F, 0x6F, ...MEM(r, 8 * r));
    emit(0xBE, ...d32(DATA));
    for (const r of GPR) emit(0xB8 | r, ...d32(Math.floor(rnd() * 2 ** 32)));
    emit(0xA1, ...d32(CTR), 0x69, 0xC0, ...d32(0x9E3779B1), 0x31, 0xC3);
    const flagsToChk = () => { emit(0x9C, 0x58, 0x25, ...d32(0x8D5), 0x31, 0x05, ...d32(CHK), 0xD1, 0x05, ...d32(CHK)); };
    const n = 30 + R(30);
    for (let i = 0; i < n; i++) {
        const kind = R(24);
        if (kind < 8) {
            const r = R(8), r1 = R(3) === 0 ? r : R(8), useMem = R(2) === 0;
            const modrm = useMem ? MEM(r, 0x400 + 8 * R(60)) : [0xC0 | r << 3 | r1];
            emit(0x0F, [0x74, 0x75, 0x76, 0xDB, 0xDF, 0xEB, 0xEF, 0x74][kind], ...modrm);
            if (R(4) === 0) emit(0x0F, 0x7F, ...MEM(r, 0x400 + 8 * R(96)));
        }
        else if (kind < 16) {
            const sub = [0, 1, 2][R(3)], useMem = R(2) === 0;
            emit(sub === 2 ? 0xF6 : 0xFE, ...(useMem ? [0x86 | sub << 3, ...d32(0x400 + R(0x400))] : [0xC0 | sub << 3 | R(8)]));
            if (R(2)) flagsToChk();
        }
        else if (kind < 22) {
            const useMem = R(2) === 0, rm = useMem ? [0x8E, ...d32(0x400 + 4 * R(0xFF))] : [0xC8 | GPR[R(GPR.length)]];
            const form = R(3);
            if (form === 2 && R(2)) emit(0xB1, [0, 1, 31, 32, 33, R(256)][R(6)]);
            if (form === 0) emit(0xC1, ...rm, [0, 1, 2, 31, 32, 33, R(256)][R(7)]);
            else if (form === 1) emit(0xD1, ...rm);
            else emit(0xD3, ...rm);
            if (R(3)) flagsToChk();
            else if (R(2)) emit(0x83, 0xD3, 0x00);
        }
        else if (kind < 23) emit(0x0F, 0x77);
        else flagsToChk();
    }
    for (let r = 0; r < 8; r++) emit(0x0F, 0x7F, ...MEM(r, 0x800 + 8 * r));
    emit(0x0F, 0x77);
    for (const r of GPR) emit(0x01, 0x05 | r << 3, ...d32(CHK + 4));
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
        let done = false, timer, cpu;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const hex = a => Buffer.from(emulator.read_memory(a.at, a.n)).toString("hex");
            resolve({ status, chk: hex({ at: CHK, n: 8 }), xmm: hex({ at: OUT, n: 128 }), data: hex({ at: DATA + 0x400, n: 0x500 }),
                      regs: Array.from({ length: 8 }, (_, i) => (cpu.reg32[i] >>> 0).toString(16)).join(",") });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; const w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1);
                if (cfg.flagLocals) cpu.set_jit_config(21, 1);
                w.set_jit_sse_scalar_inline?.(1);
                if (!w.set_jit_mmx_logic_inline || !w.set_jit_rmw_misc_inline) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_mmx_inline(1);
                w.set_jit_mmx_logic_inline(cfg.on ? 1 : 0);
                w.set_jit_rmw_misc_inline(cfg.on ? 1 : 0);
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

const sig = r => `${r.status} chk=${r.chk} regs=${r.regs} xmm=${r.xmm} data=${r.data}`;
let failures = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const img = buildImage(seed);
    const interp = await run(img, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+flaglocals", { jit: true, on: true, flagLocals: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(img, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_mmx_logic_inline/set_jit_rmw_misc_inline`); continue; }
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE in ${bad.map(([n]) => n).join(",")}`);
        console.error(`  interp ${sig(interp).slice(0, 200)}`);
        for (const [n, r] of bad) console.error(`  ${n.padEnd(14)}${sig(r).slice(0, 200)}`);
    }
    else console.log(`seed ${seed}: ok (chk=${interp.chk})`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
