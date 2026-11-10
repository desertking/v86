#!/usr/bin/env node
// Differential oracle for the self-modifying-code bail (port of upstream 2b49f4b7).
//
// A compiled module that stores into a page holding ITS OWN code must not run on into the
// stale compiled copy of the bytes it just changed. The engine refuses such a store in the
// write slow path, leaves the module through its fault edge with EIP at the storing
// instruction, and the interpreter re-runs it. Each scenario below is one guest function on
// its own code page, called in a hot loop. The function first spins an inner loop (so its page
// gets hot and compiled between patches -- every store into a page resets its heat), then on
// one call in PERIOD patches the imm32 of an `add eax, imm32` LATER IN THE SAME FUNCTION (same
// module run) and executes it, through one particular JIT write path:
//
//   store   mov [m], r32                    gen_safe_write
//   rmw     add [m], r32                    gen_safe_read_write (the bail must precede the read)
//   xchg    xchg [m], r32                   RMW whose register side effect must not happen twice
//   push    push r32 with ESP inside code   push-run coalesced write (knob 11)
//   gg      guard group: read anchor, then  member write on the slow edge (guard groups on)
//           a member write into code
//   stosd   stosd (no REP)                  inline string store
//   movq    movq [m], mm0 (8 bytes)         64-bit store
//   maskmov maskmovq (4 of 8 bytes)         writable_or_pagefault_jit pre-check + helper
//   cross   dword store straddling the end  page-crossing slow path, compiled page tail
//           of the code page
//   rep     rep stosd                       REP kernel: a block boundary, so the module exits
//                                           right after it anyway -- closed without the bail
//
// Arms per scenario: interpreter; JIT (bail on, default); JIT with jit_set_smc_bail(0) -- the
// pre-fix engine behaviour, the NEGATIVE CONTROL: every scenario but `rep` must diverge; JIT
// with jit_set_smc_bail(2) -- bail without the instruction-counter correction: registers must
// match but the instruction counter must not (negative control for the counter fix).
// Verdict: bail-on matches the interpreter in registers, checksum AND instruction counter, and
// actually bailed (jit_smc_bail_count > 0, except `rep`).
//
//   node tests/jit-smc-bail-diff.mjs [scenario...] [--engine <v86.wasm>]

import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ENGINE = opt("--engine") ? path.resolve(opt("--engine")) : path.join(__dirname, "../build/v86.wasm");
const only = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--engine"));

const BASE = 0x100000;
const ENTRY_OFF = 0x40;
const DATA = BASE + 0x1000;
const CHK = DATA, CTR = DATA + 4, MASK = DATA + 0x10, HI = DATA + 0x18;
const P = BASE + 0x2000;                 // the scenario's code page; P+0x1000 continues it
const STACK_TOP = BASE + 0x5F00;
const IMG_PAGES = 6;
const OUTER = 1 << 16, PERIOD_MASK = 0x3FF, INNER = 200;
const DONE_PORT = 0x9999;
const MEM_SIZE = 32 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const d32 = v => { v >>>= 0; return [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24]; };

// Each scenario: `w` emits the patching code (runs on one call in PERIOD, falls through to the
// tail), `t` the tail (default: site; ret). `site` is the `add eax, imm32` being patched;
// f.abs(label, k) emits the absolute address label+k.
const plainTail = f => { f.site(); f.op(0xC3); };
const SCENARIOS = {
    store: { w: f => { f.op(0x89, 0x0D); f.abs("site", 1); f.op(0x01, 0xCB); } },
    rmw: { w: f => { f.op(0x01, 0x0D); f.abs("site", 1); f.op(0x01, 0xCB); } },
    xchg: { w: f => { f.op(0x87, 0x15); f.abs("site", 1); f.op(0x01, 0xD3); } },
    push: { w: f => {
        f.op(0x89, 0xE6);                       // mov esi, esp
        f.op(0xBC); f.abs("site", 5);           // mov esp, site+5
        f.op(0x51);                             // push ecx -> [site+1]
        f.op(0x89, 0xF4);                       // mov esp, esi
    } },
    gg: {
        w: f => {
            f.op(0xBD); f.abs("site", 0);       // mov ebp, site
            f.op(0x8B, 0x7D, 0x40);             // mov edi, [ebp+0x40]   (read: group anchor)
            f.op(0x89, 0x4D, 0x01);             // mov [ebp+1], ecx      (member write -> own code)
            f.op(0x01, 0x4D, 0x44);             // add [ebp+0x44], ecx
            f.op(0x01, 0xFB);                   // add ebx, edi
        },
        t: f => { f.site(); f.op(0xC3); f.pad(0x48); },
    },
    stosd: { w: f => {
        f.op(0xFC);                             // cld
        f.op(0xBF); f.abs("site", 1);           // mov edi, site+1
        f.op(0x89, 0xC6);                       // mov esi, eax
        f.op(0x89, 0xC8);                       // mov eax, ecx
        f.op(0xAB);                             // stosd
        f.op(0x89, 0xF0);                       // mov eax, esi
    } },
    rep: { w: f => {
        f.op(0xFC);
        f.op(0xBF); f.abs("site", 1);
        f.op(0x89, 0xC6);                       // mov esi, eax
        f.op(0x89, 0xC8);                       // mov eax, ecx
        f.op(0xB9, ...d32(1));                  // mov ecx, 1
        f.op(0xF3, 0xAB);                       // rep stosd
        f.op(0x89, 0xF0);                       // mov eax, esi
    } },
    movq: {
        w: f => {
            f.op(0x0F, 0x6E, 0xC1);             // movd mm0, ecx
            f.op(0x0F, 0x62, 0xC2);             // punpckldq mm0, mm2  (high dword = 4 NOPs)
            f.op(0x0F, 0x7F, 0x05); f.abs("site", 1); // movq [site+1], mm0
        },
        t: f => { f.site(); f.op(0x90, 0x90, 0x90, 0x90); f.op(0xC3); },
    },
    maskmov: { w: f => {
        f.op(0x0F, 0x6E, 0xC1);                 // movd mm0, ecx
        f.op(0xBF); f.abs("site", 1);           // mov edi, site+1
        f.op(0x0F, 0xF7, 0xC1);                 // maskmovq mm0, mm1 (mask: low 4 bytes)
    } },
    cross: {
        w: f => {
            f.op(0x81, 0xE1, ...d32(0x00FFFFFF)); // and ecx, 0x00FFFFFF
            f.op(0x81, 0xC9, ...d32(0xC3000000)); // or ecx, 0xC3000000 (byte 3 = RET, as before)
            f.op(0x89, 0x0D, ...d32(P + 0xFFD));  // mov [P+0xFFD], ecx -- straddles P / P+0x1000
        },
        t: f => {
            f.op(0xE9); f.rel32("site");
            f.org(0xFFB); f.site();             // add eax, imm32 ends exactly at the page end
            f.op(0xC3);                         // ret, first byte of the next page
        },
    },
};
const NATURAL = new Set(["rep"]);        // closed without the bail: the module exits right after

function buildImage(name) {
    const img = new Uint8Array(IMG_PAGES * 0x1000).fill(0xCC);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true); dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true); dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + img.length, true); dv.setUint32(0x18, BASE + img.length, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    let o = 0;
    const labels = {}, fix = [];
    const emit = (...b) => { for (const x of b) img[o++] = x & 0xFF; };
    const label = n => { labels[n] = BASE + o; };
    const f = {
        op: (...b) => emit(...b),
        abs: (n, add) => { fix.push({ at: o, to: n, abs: add }); o += 4; },
        rel32: n => { fix.push({ at: o, to: n, size: 4 }); o += 4; },
        site: () => { label("site"); emit(0x05, ...d32(0x13579BDF)); },
        pad: n => { o += n; },
        org: off => { o = P - BASE + off; },
    };
    o = P - BASE;
    const sc = SCENARIOS[name];
    emit(0x51);                                 // push ecx
    emit(0xB9, ...d32(INNER));                  // mov ecx, INNER
    emit(0xD1, 0xC3, 0x31, 0xCB, 0xE2, 0xFA);   // l: rol ebx,1; xor ebx,ecx; loop l
    emit(0x59);                                 // pop ecx
    emit(0xF7, 0x05, ...d32(CTR), ...d32(PERIOD_MASK)); // test dword [CTR], PERIOD_MASK
    emit(0x75, 0); const jnzAt = o - 1;         // jnz tail
    sc.w(f);
    const rel = o - (jnzAt + 1); if (rel > 127) throw new Error("rel8"); img[jnzAt] = rel;
    (sc.t ?? plainTail)(f);

    o = ENTRY_OFF;
    emit(0xBC, ...d32(STACK_TOP));
    emit(0x0F, 0x6F, 0x0D, ...d32(MASK));       // movq mm1, [MASK]
    emit(0x0F, 0x6F, 0x15, ...d32(HI));         // movq mm2, [HI]
    for (const r of [0, 2, 3, 5, 6, 7]) emit(0xB8 + r, ...d32((0x9E3779B1 * (r + 5)) >>> 0));
    emit(0xC7, 0x05, ...d32(CTR), ...d32(OUTER));
    label("outer");
    emit(0x8B, 0x0D, ...d32(CTR));              // mov ecx, [CTR]
    emit(0x69, 0xC9, ...d32(0x9E3779B1));       // imul ecx, ecx, golden
    emit(0xE8); fix.push({ at: o, to: "fn", size: 4 }); o += 4;
    for (const r of [0, 2, 3]) emit(0x31, 0x05 | r << 3, ...d32(CHK));   // xor [CHK], r
    emit(0xD1, 0x05, ...d32(CHK));              // rol dword [CHK], 1
    emit(0xFF, 0x0D, ...d32(CTR));              // dec dword [CTR]
    emit(0x0F, 0x85); fix.push({ at: o, to: "outer", size: 4 }); o += 4;
    emit(0x0F, 0x77);                           // emms
    emit(0x66, 0xBA, DONE_PORT & 0xFF, DONE_PORT >> 8); emit(0xEE);
    emit(0xF4); emit(0xEB, 0xFE);
    labels.fn = P;

    for (const x of fix) {
        const t = labels[x.to]; if (t === undefined) throw new Error("label " + x.to);
        if (x.abs !== undefined) dv.setUint32(x.at, t + x.abs, true);
        else dv.setInt32(x.at, t - (BASE + x.at + 4), true);
    }
    // MASK: maskmovq writes bytes whose mask byte has bit 7 -- the low four (the imm32).
    dv.setUint32(MASK - BASE, 0x80808080, true); dv.setUint32(MASK - BASE + 4, 0, true);
    dv.setUint32(HI - BASE, 0x90909090, true); dv.setUint32(HI - BASE + 4, 0, true);
    return { img };
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
        const finish = status => {
            if (done) return; done = true; currentFinish = null;
            clearTimeout(timer);
            try { emulator.stop(); } catch { }
            const regs = Array.from({ length: 8 }, (_, i) => cpu.reg32[i] >>> 0);
            const b = emulator.read_memory(CHK, 4);
            const chk = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
            const code = Buffer.from(emulator.read_memory(P, 0x1010)).toString("base64");
            resolve({ status, regs, chk, code, insns: cpu.instruction_counter[0] >>> 0,
                      bails: w.jit_smc_bail_count ? w.jit_smc_bail_count() >>> 0 : -1,
                      gg: w.get_jit_guard_group_stat ? [w.get_jit_guard_group_stat(4), w.get_jit_guard_group_rt(4)] : null });
        };
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu; w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            if (cfg.jit) {
                if (!w.jit_set_smc_bail) { resolve({ status: "NO-SWITCH" }); return; }
                const knobs = new Map([[5, 1], [11, 1], [12, 1], [13, 1], [22, 1]]);
                for (const kv of (process.env.KNOBS || "").split(",").filter(Boolean)) {
                    const [i, v] = kv.split("=").map(Number); knobs.set(i, v);
                }
                for (const [i, v] of knobs) cpu.set_jit_config(i, v);
                if (w.set_jit_page_tails) w.set_jit_page_tails(1);
                if (w.set_jit_guard_groups) {
                    w.set_jit_guard_groups(cfg.gg ? 1 : 0);
                    w.set_jit_guard_groups_debug(cfg.gg ? 4 : 0);   // GG_DEBUG_COUNT: runtime role counters
                    w.jit_guard_group_stats_reset();
                }
                w.jit_set_smc_bail(cfg.bail);
                w.jit_smc_bail_count_reset();
                cpu.jit_clear_cache?.();
            }
            cpu.load_multiboot(build.img.buffer);
            cpu.io.register_write(DONE_PORT, cpu, () => finish("done"));
            timer = setTimeout(() => finish("TIMEOUT"), TIMEOUT_MS);
            currentFinish = finish;
            emulator.run();
        });
    }).finally(() => {});
}

const sig = r => `${r.status} chk=${r.chk.toString(16)} regs=${r.regs.map(x => x.toString(16)).join(",")}`;
let failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
console.log(`engine ${ENGINE}`);
for (const name of only.length ? only : Object.keys(SCENARIOS)) {
    const build = buildImage(name);
    const gg = name === "gg";
    const interp = await run(build, { jit: false });
    const on = await run(build, { jit: true, bail: 1, gg });
    if (on.status === "NO-SWITCH") { fail(`${name}: engine has no jit_set_smc_bail`); continue; }
    const off = await run(build, { jit: true, bail: 0, gg });
    const nocount = await run(build, { jit: true, bail: 2, gg });
    if (interp.status !== "done") { fail(`${name}: interpreter did not finish (${interp.status})`); continue; }
    const same = r => sig(r) === sig(interp) && r.code === interp.code;
    const note = `bails=${on.bails} insns interp=${interp.insns} on=${on.insns} off=${off.insns} nocount=${nocount.insns}` +
                 (gg ? ` ggMembers=${on.gg?.[0]} ggMemberSlowWrites=${on.gg?.[1]}` : "");
    let ok = true;
    if (!same(on)) { ok = false; fail(`${name}: bail ON diverges from the interpreter (${note})\n  interp ${sig(interp)}\n  on     ${sig(on)}`); }
    if (on.insns !== interp.insns) { ok = false; fail(`${name}: bail ON instruction counter ${on.insns} != interpreter ${interp.insns}`); }
    if (NATURAL.has(name)) {
        if (!same(off)) { ok = false; fail(`${name}: expected to be closed without the bail, but bail OFF diverges`); }
    }
    else {
        if (on.bails <= 0) { ok = false; fail(`${name}: bail ON never bailed -- the scenario did not exercise the path (${note})`); }
        if (same(off)) { ok = false; fail(`${name}: negative control inconclusive -- bail OFF matches the interpreter (${note})`); }
        if (!same(nocount)) { ok = false; fail(`${name}: bail without counter fix diverges in registers (${note})`); }
        else if (nocount.insns === interp.insns) { ok = false; fail(`${name}: counter negative control inconclusive -- counter matches without the correction`); }
    }
    // the member store must have reached its slow edge (frame 0: the anchor refused a code page)
    if (gg && !(on.gg?.[0] > 0 && on.gg?.[1] > 0)) { ok = false; fail(`${name}: no guard-group member store took the slow edge (${note})`); }
    if (ok) console.log(`${name}: ok (${note}; bail OFF ${NATURAL.has(name) ? "matches (natural)" : "DIVERGES"})`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all scenarios consistent");
process.exit(0);
