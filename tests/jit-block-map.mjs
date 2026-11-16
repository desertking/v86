#!/usr/bin/env node
// Block map (jit_block_map.rs): per published module, each basic block's guest range and the
// byte range of its code in the function body. Observation only, default OFF.
//
// Fixture, one page:
//   entry: mov ecx, ITER; mov ebx, 1
//   hot:   HOT_LEN x add eax, ebx; dec ecx; jnz hot        (HOT_LEN + 2 instructions)
//   cold:  COLD_PAIRS x (fld1; fstp st0); hlt             (2 * COLD_PAIRS + 1 instructions)
//
// Arms:
//   off     map off, trace2 off    — the reference bytes and fingerprint
//   map     map on,  trace2 off    — bytes and fingerprint must equal `off`; the map must name
//                                    the hot and cold blocks exactly and partition cleanly
//   traced  map on,  trace2 watching the page — blocks are flagged TRACED and the hot block's
//                                    range grows by the counter (the instrument is visible in
//                                    the map, which is why consumers prefer untraced copies)
//
// Negative control: with the map off nothing is recorded (count 0) even though modules were
// compiled; and the traced arm's hot-block range must DIFFER from the map arm's — if it did
// not, the byte ranges would not be measuring the emitted code at all.

const { V86 } = await import("../build/libv86.mjs");

const BASE = 0x100000;
const ENTRY_OFF = 0x40;
const HOT_LEN = 40;
const COLD_PAIRS = 12;
const ITER = 200000;
const MEM_SIZE = 16 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const FLAG_ENTRY = 1, FLAG_TRACED = 2;

function build_image()
{
    const buf = new Uint8Array(0x1000);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    [MAGIC, FLAGS, (-(MAGIC + FLAGS)) >>> 0, BASE, BASE, BASE + buf.length, BASE + 0x4000, BASE + ENTRY_OFF]
        .forEach((v, i) => dv.setUint32(i * 4, v, true));
    let o = ENTRY_OFF;
    const emit = (...bytes) => { for(const b of bytes) buf[o++] = b & 0xff; };
    const u32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };
    const L = {};
    L.entry = o;
    emit(0xB9); u32(ITER);                       // mov ecx, ITER
    emit(0xBB); u32(1);                          // mov ebx, 1
    L.hot = o;
    for(let i = 0; i < HOT_LEN; i++) emit(0x01, 0xD8);  // add eax, ebx
    emit(0x49);                                  // dec ecx
    L.jnz = o;
    emit(0x0F, 0x85); u32(L.hot - (o + 4));      // jnz hot (rel32)
    L.cold = o;
    for(let i = 0; i < COLD_PAIRS; i++) emit(0xD9, 0xE8, 0xDD, 0xD8);   // fld1; fstp st0
    L.hlt = o;
    emit(0xF4);                                  // hlt
    L.coldEnd = o;
    emit(0xEB, 0xFE);                            // jmp $
    for(const k of Object.keys(L)) L[k] += BASE;
    return { buf, L };
}

function bodyLength(bytes)
{
    let p = 8;
    const leb = () => { let v = 0, s = 0, b; do { b = bytes[p++]; v |= (b & 0x7f) << s; s += 7; } while(b & 0x80); return v >>> 0; };
    while(p < bytes.length)
    {
        const id = bytes[p++], size = leb(), end = p + size;
        if(id === 10)
        {
            leb();                          // function count (1)
            const bodySize = leb(), localsStart = p;
            const groups = leb();
            for(let i = 0; i < groups; i++) { leb(); p++; }
            return localsStart + bodySize - p - 1;      // minus the final `end`
        }
        p = end;
    }
    return -1;
}

function read_map(cpu, w)
{
    const n = w.jit_block_map_count() >>> 0;
    const ptr = w.jit_block_map_ptr() >>> 0;
    const a = new Uint32Array(cpu.wasm_memory.buffer, ptr, n * 8);
    const blocks = [];
    for(let i = 0; i < n; i++)
    {
        const r = a.subarray(i * 8, i * 8 + 8);
        blocks.push({ addr: r[0], virt: r[1], end: r[2], last: r[3], ins: r[4], from: r[5], to: r[6], flags: r[7] });
    }
    return { bodyLength: w.jit_block_map_body_length() >>> 0, blocks };
}

function run({ map, watch })
{
    return new Promise((resolve, reject) => {
        const emulator = new V86({ autostart: false, memory_size: MEM_SIZE, disable_jit: 0, log_level: 0 });
        const { buf, L } = build_image();
        const modules = [];
        let timer, fp, defaultOn;
        const finish = status => {
            clearTimeout(timer);
            try { emulator.stop(); } catch(e) {}
            delete globalThis.__jitPublicationCapture;
            const cpu = emulator.v86.cpu, w = cpu.wm.exports;
            const counts = new Map();
            if(watch)
            {
                const n = w.trace2_block_snapshot() >>> 0;
                for(let i = 0; i < n; i++) counts.set(w.trace2_block_addr(i) >>> 0, w.trace2_block_exec(i) >>> 0);
                w.trace2_reset();
            }
            const countAfter = w.jit_block_map_count() >>> 0;
            w.jit_block_map_set_enabled(0);
            resolve({ status, L, modules, fp, defaultOn, counts, countAfter, ecx: cpu.reg32[1] >>> 0 });
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            try {
                const cpu = emulator.v86.cpu, w = cpu.wm.exports;
                if(typeof w.jit_block_map_set_enabled !== "function") { reject(new Error("engine lacks jit_block_map_*")); return; }
                cpu.reboot_internal();
                cpu.reset_memory();
                defaultOn = w.jit_block_map_enabled() >>> 0;
                const fpBefore = [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0];
                w.jit_block_map_set_enabled(map ? 1 : 0);
                fp = { before: fpBefore, after: [w.jit_codegen_fingerprint_lo() >>> 0, w.jit_codegen_fingerprint_hi() >>> 0] };
                globalThis.__jitPublicationCapture = {
                    begin(start, tableIndex, slot, bytes)
                    {
                        modules.push({ start, bytes: bytes.slice(), map: read_map(cpu, w) });
                        return null;
                    },
                };
                cpu.jit_clear_cache?.();
                cpu.load_multiboot(buf.buffer);
                if(watch) w.trace2_watch_page(BASE);
                timer = setTimeout(() => finish("HANG"), TIMEOUT_MS);
                emulator.run();
            }
            catch(e) { reject(e); }
        });
    });
}

const fail = msg => { console.error("FAIL: " + msg); process.exit(1); };
const hex = v => "0x" + (v >>> 0).toString(16);
const sha = bytes => Buffer.from(bytes).toString("base64");

const off = await run({ map: false, watch: false });
const on = await run({ map: true, watch: false });
const traced = await run({ map: true, watch: true });
const { L } = on;

for(const r of [off, on, traced])
{
    if(r.status !== "halt" || r.ecx !== 0) fail(`guest did not run to completion (${r.status}, ecx=${r.ecx})`);
    if(r.defaultOn !== 0) fail("block map must default OFF");
    if(r.fp.before[0] !== r.fp.after[0] || r.fp.before[1] !== r.fp.after[1]) fail("the switch changed the codegen fingerprint");
}
// Fixture modules: the ones compiled from our page.
const ours = r => r.modules.filter(m => (m.start >>> 12) === (BASE >>> 12));
if(!ours(off).length) fail("fixture page was never compiled");

// Negative control: off records nothing.
if(off.modules.some(m => m.map.blocks.length) || off.countAfter !== 0) fail("map recorded while OFF");

// Identical bytes with the map on: it observes, it does not emit.
const shasOff = ours(off).map(m => sha(m.bytes)), shasOn = ours(on).map(m => sha(m.bytes));
if(JSON.stringify(shasOff) !== JSON.stringify(shasOn)) fail(`module bytes differ with the map on (${shasOff.length} vs ${shasOn.length} modules)`);

function check_partition(m, name)
{
    const len = bodyLength(m.bytes);
    if(m.map.bodyLength !== len) fail(`${name}: map body length ${m.map.bodyLength} != module body ${len} — map is not this module's`);
    const sorted = [...m.map.blocks].sort((a, b) => a.from - b.from);
    let prev = 0;
    for(const b of sorted)
    {
        if(b.from < prev || b.to <= b.from || b.to > len) fail(`${name}: bad range ${hex(b.addr)} [${b.from},${b.to}) body ${len}`);
        prev = b.to;
    }
}

const summarize = m => {
    const by = new Map(m.map.blocks.map(b => [b.addr, b]));
    return { hot: by.get(L.hot), cold: by.get(L.cold), entry: by.get(L.entry), all: m.map.blocks };
};
const lastOn = ours(on).at(-1), lastTraced = ours(traced).at(-1);
for(const [name, m] of [["map", lastOn], ["traced", lastTraced]])
{
    check_partition(m, name);
    const s = summarize(m);
    if(!s.hot || !s.cold) fail(`${name}: hot/cold blocks missing: ${s.all.map(b => hex(b.addr)).join(",")}`);
    if(s.hot.ins !== HOT_LEN + 2 || s.hot.end !== L.cold || s.hot.last !== L.jnz) fail(`${name}: hot block shape ${JSON.stringify(s.hot)}`);
    if(s.cold.ins !== 2 * COLD_PAIRS + 1 || s.cold.end !== L.coldEnd || s.cold.last !== L.hlt) fail(`${name}: cold block shape ${JSON.stringify(s.cold)}`);
    if(s.entry && s.entry.ins !== 2) fail(`${name}: entry block shape ${JSON.stringify(s.entry)}`);
    if(s.hot.virt !== s.hot.addr) fail(`${name}: identity-mapped fixture, virt ${hex(s.hot.virt)} != phys ${hex(s.hot.addr)}`);
}
const sOn = summarize(lastOn), sTr = summarize(lastTraced);
if(sOn.all.some(b => b.flags & FLAG_TRACED)) fail("TRACED flag set without trace2");
if(!(sTr.hot.flags & FLAG_TRACED)) fail("hot block on a watched page not flagged TRACED");
const hotBytesOn = sOn.hot.to - sOn.hot.from, hotBytesTr = sTr.hot.to - sTr.hot.from;
if(hotBytesTr <= hotBytesOn) fail(`traced hot range (${hotBytesTr} B) not larger than untraced (${hotBytesOn} B): ranges do not track emitted code`);
const hotExec = traced.counts.get(L.hot) ?? 0;
if(hotExec < ITER * 0.9 || hotExec > ITER) fail(`hot block exec ${hotExec} not within [0.9, 1] x ITER`);

console.log("jit-block-map " + JSON.stringify({
    modules: { off: ours(off).length, map: ours(on).length, traced: ours(traced).length },
    bodyLength: lastOn.map.bodyLength,
    blocks: sOn.all.map(b => ({ addr: hex(b.addr), ins: b.ins, bytes: b.to - b.from, flags: b.flags })),
    hotBytes: { untraced: hotBytesOn, traced: hotBytesTr },
    hotExec,
}));
process.exit(0);
