#!/usr/bin/env node
const { V86 } = await import("../build/libv86.mjs");

const BASE = 0x100000;
const ENTRY = BASE + 0x40;
const THUNK = BASE + 0x800;
const THUNK0 = BASE + 0x808;
const TARGET = BASE + 0x1000;
const TARGET0 = BASE + 0x1040;
const IAT = BASE + 0x1800;
const IAT0 = BASE + 0x1804;
const CTRL = 0x180000;
const STACK = 0x190000;
const DATA = 0x200000;
const OUT = 0x170000;
const ITER = 200000;
const CAPACITY = 8 * 1024 * 1024;
const MEM_SIZE = 32 * 1024 * 1024;
const TIMEOUT_MS = 30000;

function build_image()
{
    const size = 0x2000;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + size, true);
    dv.setUint32(0x18, BASE + 0x4000, true);
    dv.setUint32(0x1c, ENTRY, true);

    let o = ENTRY - BASE;
    const labels = {}, patches = [];
    const label = name => { labels[name] = o; };
    const emit = (...bytes) => { for(const b of bytes) buf[o++] = b & 0xFF; };
    const u32 = value => { dv.setUint32(o, value >>> 0, true); o += 4; };
    const rel32 = name => { patches.push({ at:o, end:o + 4, name }); emit(0, 0, 0, 0); };

    emit(0xBC); u32(STACK);
    emit(0xB9); u32(ITER);
    label("loop");
    emit(0x68); u32(0x12345678);
    emit(0xF9);
    emit(0x9C, 0x5B);
    emit(0x89, 0x1D); u32(OUT);
    emit(0xE8); rel32("thunk");
    emit(0x9C, 0x58);
    emit(0xA3); u32(OUT + 4);
    emit(0x89, 0x15); u32(OUT + 8);
    emit(0xE8); rel32("thunk0");
    emit(0x89, 0x25); u32(OUT + 12);
    emit(0x49);
    emit(0x0F, 0x85); rel32("loop");
    emit(0xF4, 0xEB, 0xFE);

    o = THUNK - BASE; label("thunk");
    emit(0xFF, 0x25); u32(IAT); emit(0x8B, 0xC0);
    o = THUNK0 - BASE; label("thunk0");
    emit(0xFF, 0x25); u32(IAT0); emit(0x8B, 0xC0);

    o = TARGET - BASE;
    emit(0x9C, 0xB8); u32(0); emit(0xBA); u32(0xB077); emit(0x9D, 0xC2, 0x04, 0x00);
    o = TARGET0 - BASE;
    emit(0x9C, 0xB8); u32(0); emit(0xBA); u32(0xB077); emit(0x9D, 0xC3);

    dv.setUint32(IAT - BASE, TARGET, true);
    dv.setUint32(IAT0 - BASE, TARGET0, true);
    for(const p of patches) dv.setInt32(p.at, labels[p.name] - p.end, true);
    return buf;
}

const fail = message => { throw new Error(message); };

function run()
{
    return new Promise((resolve, reject) => {
        const emulator = new V86({ autostart:false, memory_size:MEM_SIZE, disable_jit:0, log_level:0,
                                   wasm_path: process.env.V86_WASM_PATH || undefined });
        let timer;
        emulator.bus.register("cpu-event-halt", () => {
            clearTimeout(timer);
            try {
                const cpu = emulator.v86.cpu;
                const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.byteLength);
                const head = dv.getUint32(CTRL, true);
                const ring = [];
                for(let i = 0; i < Math.min(head, 64); i += 4) ring.push(dv.getUint32(DATA + i, true));
                resolve({
                    flagsBefore: dv.getUint32(OUT, true),
                    flagsAfter: dv.getUint32(OUT + 4, true),
                    edx: dv.getUint32(OUT + 8, true),
                    esp: dv.getUint32(OUT + 12, true),
                    head, ring,
                    hits: cpu.wm.exports.jit_wbuf_intrinsic_get_hits() >>> 0,
                    fallbacks: cpu.wm.exports.jit_wbuf_intrinsic_get_fallbacks() >>> 0,
                });
            }
            catch(error) { reject(error); }
            finally { try { emulator.stop(); } catch {} }
        });
        emulator.add_listener("emulator-loaded", () => {
            try {
                const cpu = emulator.v86.cpu;
                const ex = cpu.wm.exports;
                cpu.reboot_internal();
                cpu.reset_memory();
                const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.byteLength);
                ex.jit_wbuf_intrinsic_clear_registry();
                ex.jit_wbuf_intrinsic_set_enabled(1);
                if(ex.jit_wbuf_intrinsic_register(TARGET0, 0x55, 2, 1, 1, CTRL, DATA, CAPACITY))
                    fail("no-args kind accepted an argument count");
                if(!ex.jit_wbuf_intrinsic_register(TARGET, 0x44, 0, 1, 1, CTRL, DATA, CAPACITY))
                    fail("scalar registration failed");
                if(!ex.jit_wbuf_intrinsic_register(TARGET0, 0x55, 2, 0, 1, CTRL, DATA, CAPACITY))
                    fail("no-args registration failed");

                dv.setUint32(CTRL, 0, true);
                dv.setUint32(STACK - 4, 0xAAAA0001, true);
                dv.setUint32(STACK, 0x0BADF00D, true);
                if((ex.jit_wbuf_intrinsic_execute_tail(TARGET, STACK - 4) | 0) !== 4
                    || dv.getUint32(DATA, true) !== 0x44 || dv.getUint32(DATA + 4, true) !== 0x0BADF00D
                    || dv.getUint32(CTRL, true) !== 8)
                    fail("tail execute did not read the arguments past the return address");
                if((ex.jit_wbuf_intrinsic_execute_tail(TARGET0, STACK - 4) | 0) !== 0
                    || dv.getUint32(DATA + 8, true) !== 0x55 || dv.getUint32(DATA + 12, true) !== 0
                    || dv.getUint32(CTRL, true) !== 16)
                    fail("no-args entry is not funcId + 0");

                dv.setUint32(CTRL, 0, true);
                ex.jit_wbuf_intrinsic_reset_stats();
                cpu.jit_clear_cache?.();
                cpu.load_multiboot(build_image().buffer);
                timer = setTimeout(() => reject(new Error("guest did not halt")), TIMEOUT_MS);
                emulator.run();
            }
            catch(error) { reject(error); }
        });
    });
}

const r = await run();
console.log("jit-wbuf-intrinsic-tail-jmp " + JSON.stringify({ ...r, ring: r.ring.slice(0, 8) }));
if(r.hits === 0) fail("call -> jmp [import] -> registered stub never hit the intrinsic");
if(r.esp !== 0x190000) fail(`stack not balanced: esp=0x${r.esp.toString(16)}`);
if(r.flagsBefore !== r.flagsAfter) fail("EFLAGS changed across the intercepted call");
if(r.edx !== 0xB077) fail("register ABI mismatch");
if(r.head !== r.hits * 8) fail(`ring head ${r.head} does not match ${r.hits} hits of 8 bytes`);
for(let i = 0; i < r.ring.length; i += 2) {
    const ok = r.ring[i] === 0x44 && r.ring[i + 1] === 0x12345678 || r.ring[i] === 0x55 && r.ring[i + 1] === 0;
    if(!ok) fail(`ring entry ${i / 2} wrong: ${r.ring[i]}, ${r.ring[i + 1]}`);
}
console.log("  ok — direct CALL into a jmp [import] thunk reaches the intrinsic; no-args kind writes funcId + 0");
