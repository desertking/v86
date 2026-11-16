#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");
const args = process.argv.slice(2);
const at = args.indexOf("--engine");
const ENGINE = at >= 0 ? path.resolve(args[at + 1]) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000, ENTRY = 0x40, IMG = 0x4000;
const DATA = BASE + 0x2000, OUT = BASE + 0x2800, OUTI = BASE + 0x3000, DONE = 0x9999;

const VALUES = [
    0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, -3.5, 4503599627370495.5, -4503599627370495.5,
    0.5000000000000001, 2.5000000000000004, 3.4999999999999996, -3.4999999999999996, 0.49999999999999994,
    1e-300, 123.456, -987.25, 7, -7, 9007199254740992, 1e300,
];

function tiesToEven(x) {
    if (!Number.isFinite(x)) return x;
    const t = Math.trunc(x), frac = Math.abs(x - t);
    if (frac < 0.5) return t === 0 ? (Object.is(x, -0) || x < 0 ? -0 : 0) : t;
    if (frac > 0.5) return t + Math.sign(x);
    return t % 2 === 0 ? (t === 0 && x < 0 ? -0 : t) : t + Math.sign(x);
}

function buildImage() {
    const img = new Uint8Array(IMG).fill(0x90);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, FLAGS, true); dv.setUint32(8, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0xc, BASE, true); dv.setUint32(0x10, BASE, true); dv.setUint32(0x14, BASE + IMG, true);
    dv.setUint32(0x18, BASE + IMG, true); dv.setUint32(0x1c, BASE + ENTRY, true);
    VALUES.forEach((v, i) => dv.setFloat64(DATA - BASE + 8 * i, v, true));
    let o = ENTRY;
    const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    const d32 = v => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24 & 255];
    emit(0xBC, ...d32(BASE + 0x1F00));
    emit(0xDB, 0xE3);
    VALUES.forEach((_, i) => {
        emit(0xDD, 0x05, ...d32(DATA + 8 * i));
        emit(0xD9, 0xFC);
        emit(0xDD, 0x1D, ...d32(OUT + 8 * i));
        if (Math.abs(VALUES[i]) < 2 ** 31) {
            emit(0xDD, 0x05, ...d32(DATA + 8 * i));
            emit(0xDB, 0x1D, ...d32(OUTI + 4 * i));
        }
    });
    emit(0x66, 0xBA, DONE & 255, DONE >> 8, 0xEE, 0xF4, 0xEB, 0xFE);
    return img;
}

const result = await new Promise(resolve => {
    const emulator = new V86({ autostart: false, memory_size: 32 << 20, disable_jit: 1, log_level: 0, wasm_path: ENGINE });
    emulator.add_listener("emulator-loaded", () => {
        const cpu = emulator.v86.cpu;
        cpu.reboot_internal(); cpu.reset_memory();
        cpu.load_multiboot(buildImage().buffer);
        const timer = setTimeout(() => { emulator.stop(); resolve(null); }, 30000);
        cpu.io.register_write(DONE, cpu, () => {
            clearTimeout(timer);
            emulator.stop();
            resolve({ f: emulator.read_memory(OUT, 8 * VALUES.length), i: emulator.read_memory(OUTI, 4 * VALUES.length) });
        });
        emulator.run();
    });
});

if (!result) { console.error("TIMEOUT"); process.exit(2); }
const f = new DataView(result.f.buffer, result.f.byteOffset, result.f.byteLength);
const n = new DataView(result.i.buffer, result.i.byteOffset, result.i.byteLength);
let failures = 0;
VALUES.forEach((v, i) => {
    const want = tiesToEven(v), got = f.getFloat64(8 * i, true);
    if (!Object.is(got, want)) { failures++; console.error(`FRNDINT ${v}: got ${got}, want ${want}`); }
    if (Math.abs(v) < 2 ** 31) {
        const gotI = n.getInt32(4 * i, true);
        if (gotI !== (want | 0)) { failures++; console.error(`FISTP m32 ${v}: got ${gotI}, want ${want | 0}`); }
    }
});
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log(`all ${VALUES.length} values round to nearest even`);
