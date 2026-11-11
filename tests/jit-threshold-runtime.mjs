#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { V86 } = await import("../build/libv86.mjs");
const args = process.argv.slice(2);
const i = args.indexOf("--engine");
const ENGINE = i >= 0 ? path.resolve(args[i + 1]) : path.join(__dirname, "../build/v86.wasm");

const BASE = 0x100000, ENTRY = 0x40, IMG = 0x2000, DONE = 0x9999, CTR = BASE + 0x1F00;
const d32 = v => { v >>>= 0; return [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24]; };
function image(iterations) {
    const img = new Uint8Array(IMG).fill(0x90), dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, FLAGS, true); dv.setUint32(8, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0xc, BASE, true); dv.setUint32(0x10, BASE, true); dv.setUint32(0x14, BASE + IMG, true);
    dv.setUint32(0x18, BASE + IMG, true); dv.setUint32(0x1c, BASE + ENTRY, true);
    let o = ENTRY; const emit = (...x) => { for (const v of x) img[o++] = v & 255; };
    emit(0xBC, ...d32(BASE + 0x1E00), 0xB9, ...d32(iterations), 0x31, 0xC0);
    const loop = o;
    emit(0x05, ...d32(0x9E3779B1), 0xC1, 0xC0, 0x05, 0x49);
    emit(0x0F, 0x85, ...d32(loop - (o + 6)));
    emit(0xA3, ...d32(CTR));
    emit(0x66, 0xBA, DONE & 255, DONE >> 8, 0xEE, 0xF4, 0xEB, 0xFE);
    return img;
}
function run(threshold, iterations) {
    return new Promise(resolve => {
        const e = new V86({ autostart: false, memory_size: 32 << 20, log_level: 0, wasm_path: ENGINE });
        e.add_listener("emulator-loaded", () => {
            const cpu = e.v86.cpu, w = cpu.wm.exports;
            if (!w.set_jit_threshold) { resolve({ status: "NO-SWITCH" }); return; }
            cpu.reboot_internal(); cpu.reset_memory();
            const fpDefault = w.jit_codegen_fingerprint_lo() >>> 0;
            const before = w.get_jit_threshold();
            if (threshold !== null) w.set_jit_threshold(threshold);
            const fp = w.jit_codegen_fingerprint_lo() >>> 0;
            cpu.load_multiboot(new Uint8Array(image(iterations)).buffer);
            const t = setTimeout(() => { e.stop(); resolve({ status: "TIMEOUT", eip: (cpu.instruction_pointer[0] >>> 0).toString(16), ecx: cpu.reg32[1] }); }, 20000);
            cpu.io.register_write(DONE, cpu, () => {
                clearTimeout(t); e.stop();
                resolve({ status: "done", before, now: w.get_jit_threshold(), fpDefault, fp,
                          eax: (cpu.reg32[0] >>> 0).toString(16) });
            });
            e.run();
        });
    });
}
let fail = 0;
const ref = await run(null, 300000);
const low = await run(50000, 300000);
const back = await run(200000, 300000);
console.log(`engine ${ENGINE}`);
for (const [n, r] of [["default", ref], ["50k", low], ["200k", back]]) console.log(`${n.padEnd(8)} ${JSON.stringify(r)}`);
if (ref.status !== "done" || low.status !== "done" || back.status !== "done") { console.error("FAIL: run did not finish"); fail++; }
else {
    if (ref.before !== 200000 || ref.now !== 200000) { console.error("FAIL: default threshold is not 200000"); fail++; }
    if (low.now !== 50000) { console.error("FAIL: set_jit_threshold(50000) did not take"); fail++; }
    if (low.fp === low.fpDefault) { console.error("FAIL: a non-default threshold does not change the codegen fingerprint"); fail++; }
    if (ref.fp !== ref.fpDefault || back.fp !== back.fpDefault) { console.error("FAIL: the default threshold changes the codegen fingerprint"); fail++; }
    if (low.eax !== ref.eax || back.eax !== ref.eax) { console.error("FAIL: guest result differs between thresholds"); fail++; }
}
if (fail) process.exit(1);
console.log("threshold switch ok");
process.exit(0);
