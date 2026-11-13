#!/usr/bin/env node
// Exit-site sampling: which guest code a between-slice EIP sample names.
//
// MAX_PAGES=1 puts each page in its own JIT module:
//   page0: dec ecx; jz done; jmp page1                 (driver, 3 instructions)
//   page1: BODY_LEN x add eax,ebx; call leaf; jmp page0 (the work)
//   page2: inc edx; ret                                (a 2-instruction leaf)
//
// A slice ends at the first budget check after its budget runs out, and the body's only
// check is its exit to the leaf — which has already written the leaf's address into
// instruction_pointer. So the legacy sample (instruction_pointer between main_loop calls)
// names the leaf for the body's work. That half is the negative control: it proves the
// fixture reproduces the bias. The exit-site slot must name page1.

const { V86 } = await import("../build/libv86.mjs");

const BASE = 0x100000;
const ENTRY_OFF = 0x20;
const PAGE1_OFF = 0x1000;
const PAGE2_OFF = 0x2000;
const BODY_LEN = 300;
const ITER = 1500000;
const MEM_SIZE = 16 * 1024 * 1024;
const TIMEOUT_MS = 30000;

function build_image()
{
    const buf = new Uint8Array(PAGE2_OFF + 16);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + buf.length, true);
    dv.setUint32(0x18, BASE + 0x4000, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    let o = ENTRY_OFF;
    const labels = {}, patches = [];
    const label = n => { labels[n] = o; };
    const emit = (...bytes) => { for(const b of bytes) buf[o++] = b & 0xff; };
    const u32 = value => { dv.setUint32(o, value >>> 0, true); o += 4; };
    const rel8 = n => { patches.push({ at: o, sz: 1, end: o + 1, to: n }); emit(0); };
    const rel32 = n => { patches.push({ at: o, sz: 4, end: o + 4, to: n }); emit(0, 0, 0, 0); };

    emit(0xB9); u32(ITER);                 // mov ecx, ITER
    emit(0xBB); u32(1);                    // mov ebx, 1
    label("top");
    emit(0x49);                            // dec ecx
    emit(0x74); rel8("done");              // jz done
    emit(0xE9); rel32("body");             // jmp body
    label("done");
    emit(0xF4); emit(0xEB, 0xFE);          // hlt; jmp $

    o = PAGE1_OFF;
    label("body");
    for(let i = 0; i < BODY_LEN; i++) emit(0x01, 0xD8);   // add eax, ebx
    label("call");
    emit(0xE8); rel32("leaf");             // call leaf
    emit(0xE9); rel32("top");              // jmp top

    o = PAGE2_OFF;
    label("leaf");
    emit(0x42);                            // inc edx
    emit(0xC3);                            // ret

    for(const p of patches)
    {
        const d = labels[p.to] - p.end;
        if(p.sz === 1) buf[p.at] = d & 0xff;
        else dv.setInt32(p.at, d, true);
    }
    return { buf, callAddr: BASE + labels.call };
}

function run(sampling, directChaining = false)
{
    return new Promise((resolve, reject) => {
        const emulator = new V86({
            autostart: false,
            memory_size: MEM_SIZE,
            disable_jit: 0,
            log_level: 0,
        });
        const legacy = new Map(), exitSite = new Map();
        const bump = (m, a) => m.set(a, (m.get(a) ?? 0) + 1);
        let halted = false, timer, t0 = 0, fp = null, defaultSampling = null, ticks = 0;
        const { buf, callAddr } = build_image();

        const finish = status => {
            clearTimeout(timer);
            const elapsedMs = performance.now() - t0;
            try { emulator.stop(); } catch(e) {}
            const cpu = emulator.v86.cpu;
            resolve({
                status, elapsedMs, ticks, fp, defaultSampling, callAddr,
                ecx: cpu.reg32[1] >>> 0,
                edx: cpu.reg32[2] >>> 0,
                legacy, exitSite,
            });
        };

        emulator.bus.register("cpu-event-halt", () => { halted = true; finish("halt"); });
        emulator.add_listener("emulator-loaded", () => {
            try {
                const cpu = emulator.v86.cpu;
                const w = cpu.wm.exports;
                if(typeof w.set_jit_exit_site_sampling !== "function" || typeof w.jit_exit_site_eip !== "function")
                {
                    reject(new Error("engine lacks set_jit_exit_site_sampling/jit_exit_site_eip"));
                    return;
                }
                cpu.reboot_internal();
                cpu.reset_memory();
                defaultSampling = w.get_jit_exit_site_sampling() >>> 0;
                cpu.set_jit_config(1, 1);   // MAX_PAGES=1: one module per page
                cpu.set_jit_config(2, 1);   // loop safety (shipping)
                cpu.set_jit_config(4, directChaining ? 1 : 0);   // shipping: OFF
                cpu.set_jit_config(12, 1);  // RET chaining ON (shipping)
                const fpOff = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                w.set_jit_exit_site_sampling(sampling ? 1 : 0);
                const fpNow = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                fp = { off: fpOff, now: fpNow };
                cpu.jit_clear_cache?.();
                cpu.load_multiboot(buf.buffer);

                const ip = cpu.instruction_pointer;
                const mainLoop = cpu.main_loop;
                cpu.main_loop = function()
                {
                    const r = mainLoop.apply(this, arguments);
                    ticks++;
                    bump(legacy, ip[0] >>> 0);
                    bump(exitSite, w.jit_exit_site_eip() >>> 0);
                    return r;
                };
                t0 = performance.now();
                timer = setTimeout(() => { if(!halted) finish("HANG"); }, TIMEOUT_MS);
                emulator.run();
            }
            catch(e) { reject(e); }
        });
    });
}

const page = a => (a >>> 0) & ~0xFFF;
function shares(m)
{
    let total = 0;
    const byPage = new Map();
    for(const [a, n] of m) { total += n; byPage.set(page(a), (byPage.get(page(a)) ?? 0) + n); }
    const pct = p => total ? Math.round(1000 * (byPage.get(BASE + p) ?? 0) / total) / 10 : 0;
    const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return { total, driver: pct(0), body: pct(PAGE1_OFF), leaf: pct(PAGE2_OFF), top: top ? "0x" + top[0].toString(16) : null };
}

const off = await run(false);
const on = await run(true);
// Direct chaining reaches its budget exits through a different emitter (the inline chain
// lookup), so it gets its own arm.
const chained = await run(true, true);
const report = {
    off: { status: off.status, elapsedMs: Math.round(off.elapsedMs), ticks: off.ticks, legacy: shares(off.legacy), exitSite: shares(off.exitSite), fp: off.fp },
    on: { status: on.status, elapsedMs: Math.round(on.elapsedMs), ticks: on.ticks, legacy: shares(on.legacy), exitSite: shares(on.exitSite), fp: on.fp },
    chained: { status: chained.status, elapsedMs: Math.round(chained.elapsedMs), ticks: chained.ticks, legacy: shares(chained.legacy), exitSite: shares(chained.exitSite) },
    callAddr: "0x" + on.callAddr.toString(16),
    // Exact retired-instruction shares of the fixture, per iteration.
    expected: { driver: 3, body: BODY_LEN + 2, leaf: 2 },
};
console.log("jit-exit-site-sampling " + JSON.stringify(report));

const fail = msg => { console.error("FAIL: " + msg); process.exit(1); };

for(const r of [off, on, chained])
{
    if(r.status !== "halt" || r.ecx !== 0 || r.edx !== ITER - 1) fail(`guest did not run to completion (${r.status} ecx=${r.ecx} edx=${r.edx})`);
    if(r.defaultSampling !== 0) fail("exit-site sampling must default OFF");
}
const enough = 50;
if(Math.min(off.ticks, on.ticks, chained.ticks) < enough) fail(`too few slices to judge (${off.ticks}/${on.ticks}/${chained.ticks}); raise ITER`);

// Default-off must not perturb the codegen fingerprint; ON must change it (the AOT cache
// keys persisted modules on it).
if(off.fp.now[0] !== off.fp.off[0] || off.fp.now[1] !== off.fp.off[1]) fail("OFF changed the codegen fingerprint");
if(on.fp.now[0] === on.fp.off[0] && on.fp.now[1] === on.fp.off[1]) fail("ON did not change the codegen fingerprint");

// Negative control: the legacy channel must reproduce the bias, otherwise this fixture
// does not exercise the bug and the assertion below proves nothing.
const lg = shares(on.legacy);
if(lg.leaf < 60) fail(`fixture does not reproduce the legacy bias (legacy leaf share ${lg.leaf}%)`);

// With sampling OFF nothing writes the slot.
const offSite = shares(off.exitSite);
if(offSite.body !== 0 || offSite.leaf !== 0) fail("slot written while sampling was OFF");

// The fix: the body owns ~98% of the retired instructions, and the exit-site channel says so.
for(const [name, r] of [["unchained", on], ["chained", chained]])
{
    const es = shares(r.exitSite);
    if(es.body < 85) fail(`${name}: exit-site channel does not attribute the body (${es.body}%)`);
    if(es.leaf > 10) fail(`${name}: exit-site channel still charges the leaf (${es.leaf}%)`);
    if(es.top !== report.callAddr) fail(`${name}: top exit site ${es.top} is not the body's call ${report.callAddr}`);
}

process.exit(0);
