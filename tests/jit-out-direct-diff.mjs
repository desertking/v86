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

const BASE = 0x100000, ENTRY = 0x40, IMG = 0x9000;
const OUT = BASE + 0x7000, CHK = BASE + 0x7F00, CTR = BASE + 0x7F10;
const STACK_TOP = BASE + 0x8F00, DONE = 0x9999, PORT = 0x5A5A, OUTER = 20000;

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
    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    const patchSites = [];
    emit(0xBC, ...d32(STACK_TOP));
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    emit(0xBA, ...d32(PORT));
    const loop = o;
    emit(0xA1, ...d32(CTR), 0x69, 0xC0, ...d32(0x9E3779B1), 0x89, 0xC3, 0xC1, 0xC3, 0x07, 0x89, 0xC1);
    const n = 6 + R(8);
    for (let i = 0; i < n; i++) {
        const k = R(6);
        if (k === 0) emit(0x01, 0xD8, 0x83, 0xD1, 0x00);
        else if (k === 1) emit(0x31, 0xC3, 0xC1, 0xC0, R(32));
        else if (k === 2) { emit(0x05); patchSites.push(o); emit(...d32(R(2 ** 32))); }
        else if (k === 3) emit(0x39, 0xD8, 0x72, 0x02, 0x41, 0x41);
        else if (k === 4) emit(0x01, 0x05, ...d32(CHK), 0x11, 0x1D, ...d32(CHK + 4));
        else emit(0x0F, 0xAF, 0xC1);
        if (R(2)) {
            emit(0x01, 0xC8, 0x83, 0xF8, 0x00);
            emit(0xEF);
            emit(0x8D, 0x80); patchSites.push(o); emit(...d32(R(2 ** 32)));
            emit(0x0F, 0x92, 0xC4);
            emit(0x31, 0x05, ...d32(CHK + 8));
            emit(0x01, 0xC3);
        }
    }
    emit(0x31, 0x05, ...d32(CHK), 0x01, 0x1D, ...d32(CHK + 4), 0x31, 0x0D, ...d32(CHK + 12));
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    emit(0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE);
    const alt = o;
    emit(0x81, 0x35, ...d32(CHK + 12), ...d32(0x5BD1E995));
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    emit(0x66, 0xBA, ...d16(DONE), 0xEE, 0xF4, 0xEB, 0xFE);
    return { img, alt: BASE + alt, patchSites: patchSites.map(p => BASE + p) };
}

let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 60));
    else { console.error(e); process.exit(2); }
});

function run(image, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: cfg.jit ? 0 : 1, log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w, calls = 0, log = 0, lastIc = -1, stale = 0;
        const finish = status => {
            if (done) return; done = true; currentFinish = null; clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const hex = a => Buffer.from(emulator.read_memory(a.at, a.n)).toString("hex");
            resolve({ status, chk: hex({ at: CHK, n: 16 }), log: (log >>> 0).toString(16), calls, stale,
                      regs: Array.from({ length: 8 }, (_, i) => (cpu.reg32[i] >>> 0).toString(16)).join(","),
                      cont: w?.jit_out_direct_get_continues?.() ?? -1, exits: w?.jit_out_direct_get_exits?.() ?? -1, modules: w?.jit_debug_module_count?.() ?? -1 });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                for (const [i, v] of [[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]) cpu.set_jit_config(i, v);
                w.set_jit_page_tails?.(1); w.set_jit_guard_groups?.(1); w.set_jit_smc_exit?.(1);
                if (cfg.flagLocals) cpu.set_jit_config(21, 1);
                if (!w.set_jit_out_direct) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_out_direct(cfg.on ? 1 : 0);
                w.set_jit_threshold?.(2000);
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(image.img.buffer);
            const write32 = v => {
                calls++;
                const ic = cpu.instruction_counter[0] >>> 0;
                if (ic === lastIc) stale++;
                lastIc = ic;
                log = Math.imul(log ^ v, 0x01000193) ^ cpu.reg32[1];
                cpu.reg32[0] = Math.imul(v, 0x45D9F3B) ^ calls;
                if (calls % 7 === 3) cpu.reg32[3] = (cpu.reg32[3] + calls) | 0;
                if (calls % 13 === 5) {
                    const esp = cpu.reg32[4] >>> 0;
                    cpu.instruction_pointer[0] = image.alt;
                    cpu.reg32[4] = esp;
                }
                if (image.patchSites.length && (calls === 30001 || calls === 60001)) {
                    const next = cpu.instruction_pointer[0] >>> 0;
                    const site = image.patchSites.includes(next + 2) ? next + 2 : image.patchSites[calls % image.patchSites.length];
                    cpu.write_blob(new Uint8Array(d32(Math.imul(calls, 0x2545F491))), site);
                }
            };
            cpu.io.register_write(PORT, cpu, () => {}, () => {}, write32);
            cpu.io.register_write(DONE, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), 120000);
            currentFinish = finish;
            emulator.run();
        });
    });
}

const sig = r => `${r.status} chk=${r.chk} log=${r.log} calls=${r.calls} regs=${r.regs}`;
let failures = 0, directSeen = 0;
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const image = buildImage(seed);
    const interp = await run(image, { jit: false });
    const arms = [["off", { jit: true, on: false }], ["on", { jit: true, on: true }], ["on+flaglocals", { jit: true, on: true, flagLocals: true }]];
    const res = [];
    for (const [name, cfg] of arms) res.push([name, await run(image, cfg)]);
    if (interp.status !== "done") { failures++; console.error(`FAIL seed ${seed}: interpreter ${interp.status}`); continue; }
    if (res.some(([, r]) => r.status === "NO-SWITCH")) { failures++; console.error(`FAIL seed ${seed}: engine has no set_jit_out_direct`); continue; }
    for (const [n, r] of res) if (n !== "off") directSeen += r.cont;
    const bad = res.filter(([, r]) => sig(r) !== sig(interp));
    for (const [n, r] of res) if (r.stale > 2) bad.push([n + "(stale counter x" + r.stale + ")", r]);
    if (bad.length) {
        failures++;
        console.error(`FAIL seed ${seed}: DIVERGENCE in ${bad.map(([n]) => n).join(",")}`);
        console.error(`  interp ${sig(interp).slice(0, 220)}`);
        for (const [n, r] of bad) console.error(`  ${n.padEnd(14)}${sig(r).slice(0, 220)}`);
    }
    else console.log(`seed ${seed}: ok (calls=${interp.calls} direct continues=${res[1][1].cont} exits=${res[1][1].exits} modules=${res[1][1].modules}/${res[0][1].modules})`);
}
if (!failures && directSeen === 0) { failures++; console.error("FAIL: the direct OUT path never continued inside a module"); }
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
