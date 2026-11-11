#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
globalThis.__fs = fs;
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--engine"));
const SEED_START = parseInt(positional[0] ?? "1", 10);
const SEED_COUNT = parseInt(positional[1] ?? "8", 10);
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000;
const ENTRY_OFF = 0x40;
const DATA = BASE + 0x1000;
const CHK = DATA, CTR = DATA + 4;
const STACK_TOP = BASE + 0x1F00;
const N_CALLERS = 6, N_CALLEES = 10;
const CALLER_PAGE0 = 2, CALLEE_PAGE0 = CALLER_PAGE0 + N_CALLERS;
const IMG_PAGES = CALLEE_PAGE0 + N_CALLEES + 1;
const OUTER = 60000;
const PATCH_GUEST_AT = process.env.NOPATCH || process.env.NOGUEST ? 1e9 : 30000, PATCH_HOST_AT = process.env.NOPATCH || process.env.NOHOST ? 1e9 : 45000;
const DONE_PORT = 0x9999, HOST_PORT = 0x9990, FENCE_PORT = 0x9991;
const PD = 0x300000, PT0 = 0x301000;
const MEM_SIZE = 32 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

function mulberry32(a) {
    return () => {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const d32 = v => { v >>>= 0; return [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24]; };
const OPS = [
    { e: i => [0x05, ...d32(i)], imm: 1 },
    { e: i => [0x81, 0xF1, ...d32(i)], imm: 2 },
    { e: i => [0x69, 0xD2, ...d32(i | 1)], imm: 2 },
    { e: i => [0x81, 0xC3, ...d32(i)], imm: 2 },
    { e: i => [0x81, 0xC6, ...d32(i)], imm: 2 },
    { e: i => [0x81, 0xF7, ...d32(i)], imm: 2 },
    { e: i => [0xC1, 0xC0, 1 + (i & 15)], imm: -1 },
    { e: () => [0x01, 0xC7], imm: -1 },
    { e: () => [0x31, 0xD9], imm: -1 },
    { e: () => [0x0F, 0xAF, 0xC2], imm: -1 },
    { e: () => [0x46], imm: -1 },
];

function buildImage(seed) {
    const rnd = mulberry32(seed);
    const R = n => Math.floor(rnd() * n);
    const rand32 = () => (rnd() * 2 ** 32) >>> 0;
    const img = new Uint8Array(IMG_PAGES * 0x1000).fill(0xCC);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true); dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true); dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + img.length, true); dv.setUint32(0x18, BASE + img.length, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    let o = 0;
    const fix = [], labels = {};
    const emit = (...b) => { for (const x of b) img[o++] = x & 0xFF; };
    const rel32 = to => { fix.push({ at: o, to, size: 4 }); o += 4; };
    const rel8 = to => { fix.push({ at: o, to, size: 1 }); o += 1; };
    const label = n => { labels[n] = BASE + o; };
    const body = (n, sites) => {
        for (let i = 0; i < n; i++) {
            const op = OPS[R(OPS.length)], at = o;
            emit(...op.e(rand32()));
            if (op.imm >= 0) sites.push(BASE + at + op.imm);
        }
    };

    const calleeSites = [];
    for (let k = 0; k < N_CALLEES; k++) {
        o = (CALLEE_PAGE0 + k) * 0x1000 + 0x40 + R(0x600);
        label(`c${k}`);
        body(3 + R(6), calleeSites);
        if (k + 1 < N_CALLEES && R(3) === 0) { emit(0xE8); rel32(`c${k + 1 + R(N_CALLEES - k - 1)}`); body(1 + R(3), calleeSites); }
        emit(0x3D, ...d32(rand32())); emit(0x70 + [2, 3, 4, 5, 8, 9][R(6)]); emit(3); emit(0xC1, 0xC0, 3);
        body(1 + R(3), calleeSites);
        emit(0xC3);
    }
    for (let j = 0; j < N_CALLERS; j++) {
        o = (CALLER_PAGE0 + j) * 0x1000 + 0x80 + R(0x400);
        label(`p${j}`);
        const n = 4 + R(4);
        for (let i = 0; i < n; i++) { body(1 + R(2), []); emit(0xE8); rel32(`c${R(N_CALLEES)}`); }
        emit(0xC3);
    }

    o = ENTRY_OFF;
    emit(0xBC, ...d32(STACK_TOP));
    emit(0xB8, ...d32(PT0 | 3)); emit(0xA3, ...d32(PD));
    emit(0xB8, ...d32(3)); emit(0xB9, ...d32(1024)); emit(0xBA, ...d32(PT0));
    label("pt"); emit(0x89, 0x02); emit(0x05, ...d32(0x1000)); emit(0x83, 0xC2, 4); emit(0x49);
    emit(0x75); rel8("pt");
    emit(0xB8, ...d32(PD)); emit(0x0F, 0x22, 0xD8);
    emit(0x0F, 0x20, 0xC0); emit(0x0D, ...d32(0x80000000)); emit(0x0F, 0x22, 0xC0);
    for (const r of [0, 1, 2, 3, 6, 7]) emit(0xB8 + r, ...d32((0x9E3779B1 * (r + 5)) >>> 0));
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    label("outer");
    for (let j = 0; j < N_CALLERS; j++) {
        emit(0xE8); rel32(`p${j}`);
        for (const r of [0, 1, 2, 3, 6, 7]) emit(0x31, 0x05 | r << 3, ...d32(CHK));
        emit(0xD1, 0x05, ...d32(CHK));
    }
    const guestSites = calleeSites.filter((_, i) => i % 2 === 0).slice(0, 16)
        .filter((_, i) => !process.env.GUESTMASK || (Number(process.env.GUESTMASK) >> i & 1));
    const hostSites = calleeSites.filter((_, i) => i % 2 === 1).slice(0, 16);
    emit(0x81, 0x3D, ...d32(CTR), ...d32(OUTER - PATCH_GUEST_AT));
    emit(0x0F, 0x85); rel32("noguest");
    for (const a of guestSites) emit(0xC7, 0x05, ...d32(a), ...d32(rand32() | 1));
    if (!process.env.SMC_NO_FENCE) { emit(0x66, 0xBA, FENCE_PORT & 0xFF, FENCE_PORT >> 8); emit(0xEE); }
    label("noguest");
    emit(0x81, 0x3D, ...d32(CTR), ...d32(OUTER - PATCH_HOST_AT));
    emit(0x75); rel8("nohost");
    emit(0x66, 0xBA, HOST_PORT & 0xFF, HOST_PORT >> 8); emit(0xEE);
    label("nohost");
    emit(0xFF, 0x0D, ...d32(CTR));
    emit(0x0F, 0x85); rel32("outer");
    emit(0x66, 0xBA, DONE_PORT & 0xFF, DONE_PORT >> 8); emit(0xEE);
    emit(0xF4); emit(0xEB, 0xFE);

    for (const f of fix) {
        const t = labels[f.to]; if (t === undefined) throw new Error("label " + f.to);
        const d = t - (BASE + f.at + f.size);
        if (f.size === 1) { if (d < -128 || d > 127) throw new Error("rel8 " + f.to); img[f.at] = d & 0xFF; }
        else dv.setInt32(f.at, d, true);
    }
    if (process.env.DEBUG_LAYOUT) {
        console.log("labels", Object.entries(labels).filter(([n]) => /^[cp]\d/.test(n)).map(([n, a]) => n + "=" + a.toString(16)).join(" "));
        console.log("guestSites", guestSites.map(a => a.toString(16)).join(" "));
        require_dump: { const fs = globalThis.process && import("node:fs"); }
        globalThis.__img = img;
    }
    return { img, hostPatch: hostSites.map(a => ({ a, v: rand32() | 1 })), guestSites };
}

let currentFinish = null;
process.on("uncaughtException", e => {
    if (currentFinish) currentFinish("THREW " + String(e.message ?? e).slice(0, 60));
    else { console.error(e); process.exit(2); }
});

function run(build, cfg) {
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: MEM_SIZE, disable_jit: cfg.jit ? 0 : 1,
                                   log_level: 0, wasm_path: ENGINE });
        let done = false, timer, cpu, w;
        if (process.env.DUMP_MODULES && cfg.jit) globalThis.__wasmDump = { out: [] };
        const finish = status => {
            if (done) return; done = true; currentFinish = null;
            clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const regs = Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0);
            const b = emulator.read_memory(CHK, 4);
            const chk = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
            const st = i => (w?.profiler_dispatch_stat_get ? w.profiler_dispatch_stat_get(i) : -1);
            if (globalThis.__wasmDump) {
                const fs = globalThis.__fs;
                fs.writeFileSync(`${process.env.DUMP_MODULES}-${cfg.regions ? "on" : "off"}.json`,
                    JSON.stringify(globalThis.__wasmDump.out.map(m => Buffer.from(m.bytes).toString("base64"))));
                delete globalThis.__wasmDump;
            }
            resolve({ status, regs, chk, retHit: st(11), memoHit: st(18) });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                const knobs = new Map([[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]);
                for (const kv of (process.env.KNOBS || "").split(",").filter(Boolean)) {
                    const [i, v] = kv.split("=").map(Number); knobs.set(i, v);
                }
                for (const [i, v] of knobs) cpu.set_jit_config(i, v);
                if (!w.set_jit_ret_memo_inline) { resolve({ status: "NO-SWITCH" }); return; }
                w.set_jit_ret_memo_inline(cfg.regions ? 1 : 0);
                w.set_dispatch_stats(1);
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(build.img.buffer);
            cpu.io.register_write(DONE_PORT, cpu, () => finish("done"));
            cpu.io.register_write(FENCE_PORT, cpu, () => {});
            cpu.io.register_write(HOST_PORT, cpu, () => {
                for (const { a, v } of build.hostPatch) {
                    cpu.mem8.set(d32(v), a);
                    w.jit_dirty_cache(a, a + 4);
                }
            });
            timer = setTimeout(() => finish("TIMEOUT"), TIMEOUT_MS);
            currentFinish = finish;
            emulator.run();
        });
    });
}

const sig = r => `${r.status} chk=${r.chk.toString(16)} regs=${r.regs.map(x => x.toString(16)).join(",")}`;
let failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
console.log(`engine ${ENGINE}`);
for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const build = buildImage(seed);
    const interp = await run(build, { jit: false });
    const off = await run(build, { jit: true, regions: false });
    const on = await run(build, { jit: true, regions: true });
    if (interp.status !== "done") { fail(`seed ${seed}: interpreter did not finish (${interp.status})`); continue; }
    if (on.status === "NO-SWITCH") { fail(`seed ${seed}: engine has no set_jit_ret_memo_inline`); continue; }
    const note = ` (memoHit off=${off.memoHit} on=${on.memoHit} retChain off=${off.retHit} on=${on.retHit})`;
    const okOff = sig(off) === sig(interp), okOn = sig(on) === sig(interp);
    if (okOff && okOn) console.log(`seed ${seed}: ok${note}`);
    else {
        fail(`seed ${seed}: DIVERGENCE${note}`);
        console.error(`  interp ${sig(interp)}\n  off    ${sig(off)}\n  on     ${sig(on)}`);
    }
    if (on.memoHit <= 0) fail(`seed ${seed}: probe ON served no memo hit — the arm did not exercise the feature`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all seeds consistent");
process.exit(0);
