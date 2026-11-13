#!/usr/bin/env node
// Differential for jit_x87_m80_inline (FLD m80 / FSTP m80 inline in relaxed FPU mode).
//
// A table of 80-bit images (exact f64 values, values with low significand bits set,
// unnormals, denormals, pseudo-denormals, zeros, infinities, NaNs, the 0x7FFE image and the
// exponent edges of the f64 range) and of f64 values runs through four copy chains in a hot
// loop under three control words:
//   m80 -> m80, m80 -> m64, m64 -> m80, and m80 -> FLD ST(0) -> two FSTP m80.
// Oracles: the strict interpreter and the relaxed interpreter. Every JIT arm must write the
// same bytes and end with the same status, control and tag words. The switch-on arm must
// also take the inline store (FPU_RELAXED_HIT rises against switch off).
// Negative control: mode 2 converts images whose low significand bits are set, which
// truncates them, so its output must differ from the oracle.
//
//   node tests/jit-x87-m80-inline-diff.mjs

const { V86 } = await import("../build/libv86.mjs");
const WASM_PATH = process.env.V86_WASM_PATH || new URL("../build/v86.wasm", import.meta.url)
    .pathname.replace(/^\/([A-Za-z]:)/, "$1");

const BASE = 0x100000, ENTRY_OFF = 0x40, IMG_SIZE = 0x8000;
const DATA = BASE + 0x2000;
const SRC80 = DATA, SRC64 = DATA + 0x400;
const OUTA = DATA + 0x800, OUTB = DATA + 0xC00, OUTC = DATA + 0x1000, OUTD = DATA + 0x1400, OUTE = DATA + 0x1800;
const CW = DATA + 0x1C00, STS = DATA + 0x1C04, ENV = DATA + 0x1C10;
const OUT_LO = OUTA, OUT_HI = ENV + 28;
const OUTER = 4000;
const ALIAS = 24;
const MEM_SIZE = 16 * 1024 * 1024;

const HI = 1n << 63n;
function f64ToImage(x)
{
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x, true);
    const bits = dv.getBigUint64(0, true);
    const sign = Number(bits >> 63n) << 15;
    const exp = Number(bits >> 52n & 0x7FFn);
    const frac = bits & ((1n << 52n) - 1n);
    if(exp === 0 && frac === 0n) return [0n, sign];
    return [HI | frac << 11n, sign | (exp + 16383 - 1023)];
}

function images()
{
    const out = [];
    for(const x of [1, -1, 1.5, 3.141592653589793, -2.718281828459045, 1e300, -1e-300, 2 ** -1022, 1.7976931348623157e308, 123456789.125])
        out.push(f64ToImage(x));
    out.push([0n, 0]);
    out.push([0n, 0x8000]);
    const [m1, e1] = f64ToImage(1.5);
    out.push([m1 | 1n, e1]);
    out.push([m1 | 0x400n, e1 | 0x8000]);
    out.push([m1 & ~HI, e1]);
    out.push([0x123456789n, 0]);
    out.push([HI | 0x55n, 0]);
    out.push([HI, 0x7FFF]);
    out.push([HI, 0xFFFF]);
    out.push([HI | 1n << 62n, 0x7FFF]);
    out.push([HI | 1n << 61n, 0x7FFF]);
    out.push([HI, 16383 - 1023]);
    out.push([HI, 16383 + 1024]);
    out.push([HI | 0x7FFn << 11n, 16383 + 1023]);
    out.push([HI, 0x7FFE]);
    out.push([HI | 0xABCn << 20n, 0xFFFE]);
    out.push([HI, 1]);
    out.push([HI | 1n << 11n, 16383 - 1022]);
    out.push([0xFFFFFFFFFFFFF800n, 16383 + 1023]);
    out.push([0xFFFFFFFFFFFFFC00n, 16383 + 1023]);
    out.push([HI | 1n << 11n, 0x8000 | (16383 + 7)]);
    while(out.length < 32) out.push(f64ToImage(out.length * 0.1));
    return out;
}

const F64S = [1.25, -0.0, 0, Infinity, -Infinity, NaN, 5e-324, -2.2250738585072014e-308, 1.7976931348623157e308, 0.1,
    1e-310, -3.5, 65504, 2 ** 52 + 1, 1 / 3, -1 / 7];

function buildImage(cw)
{
    const buf = new Uint8Array(IMG_SIZE);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + IMG_SIZE, true);
    dv.setUint32(0x18, BASE + IMG_SIZE, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    const imgs = images();
    imgs.forEach(([m, se], i) => {
        dv.setBigUint64(SRC80 - BASE + i * 16, BigInt.asUintN(64, m), true);
        dv.setUint16(SRC80 - BASE + i * 16 + 8, se, true);
    });
    for(let i = 0; i < 32; i++) dv.setFloat64(SRC64 - BASE + i * 8, F64S[i % F64S.length] * (i < 16 ? 1 : -1), true);
    dv.setUint16(CW - BASE, cw, true);

    let o = ENTRY_OFF;
    const labels = {}, patches = [];
    const emit = (...b) => { for(const x of b) buf[o++] = x & 0xff; };
    const imm32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };
    const label = n => { labels[n] = o; };
    const rel32 = n => { patches.push({ at: o, to: n, end: o + 4 }); o += 4; };

    emit(0xBC); imm32(BASE + 0x7F00);       // mov esp, stack
    emit(0xDB, 0xE3);                       // fninit
    emit(0xD9, 0x2D); imm32(CW);            // fldcw [CW]
    emit(0xBD); imm32(OUTER);               // mov ebp, OUTER
    label("outer");
    emit(0x31, 0xF6);                       // xor esi, esi
    emit(0x31, 0xDB);                       // xor ebx, ebx
    label("inner");
    emit(0xDB, 0xAE); imm32(SRC80);         // fld tbyte [esi+SRC80]
    emit(0xDB, 0xBE); imm32(OUTA);          // fstp tbyte [esi+OUTA]
    emit(0xDB, 0xAE); imm32(SRC80);         // fld tbyte [esi+SRC80]
    emit(0xDD, 0x9B); imm32(OUTB);          // fstp qword [ebx+OUTB]
    emit(0xDD, 0x83); imm32(SRC64);         // fld qword [ebx+SRC64]
    emit(0xDB, 0xBE); imm32(OUTC);          // fstp tbyte [esi+OUTC]
    emit(0xDB, 0xAE); imm32(SRC80);         // fld tbyte [esi+SRC80]
    emit(0xD9, 0xC0);                       // fld st(0)
    emit(0xDB, 0xBE); imm32(OUTD);          // fstp tbyte [esi+OUTD]
    emit(0xDB, 0xBE); imm32(OUTE);          // fstp tbyte [esi+OUTE]
    emit(0x83, 0xC6, 0x10);                 // add esi, 16
    emit(0x83, 0xC3, 0x08);                 // add ebx, 8
    emit(0x81, 0xFE); imm32(32 * 16);       // cmp esi, 512
    emit(0x0F, 0x82); rel32("inner");       // jb inner
    emit(0x4D);                             // dec ebp
    emit(0x0F, 0x85); rel32("outer");       // jnz outer
    emit(0xDD, 0x3D); imm32(STS);           // fnstsw [STS]
    emit(0xD9, 0x35); imm32(ENV);           // fnstenv [ENV]
    emit(0xF4);                             // hlt
    emit(0xEB, 0xFE);
    for(const p of patches) dv.setInt32(p.at, labels[p.to] - p.end, true);
    return buf;
}

function run(cw, { jit, relaxed, mode = 0, x87Locals = false })
{
    return new Promise(resolve => {
        const emulator = new V86({ autostart: false, memory_size: MEM_SIZE, wasm_path: WASM_PATH,
                                   disable_jit: jit ? 0 : 1, log_level: 0 });
        let timer;
        const finish = status => {
            clearTimeout(timer);
            try { emulator.stop(); } catch {}
            const cpu = emulator.v86.cpu;
            const ex = cpu.wm.exports;
            const mem = cpu.mem8.slice(OUT_LO, OUT_HI);
            const env = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + ENV, 28);
            resolve({
                status, mem,
                sw: cpu.mem8[STS] | cpu.mem8[STS + 1] << 8,
                cwOut: env.getUint16(0, true), swEnv: env.getUint16(4, true), tag: env.getUint16(8, true),
                hit: typeof ex.profiler_fpu_relaxed_hit_get === "function" ? Number(ex.profiler_fpu_relaxed_hit_get()) : -1,
                hasSwitch: typeof ex.set_jit_x87_m80_inline === "function",
            });
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            const cpu = emulator.v86.cpu;
            const ex = cpu.wm.exports;
            const apply = () => {
                ex.set_relaxed_fpu(relaxed ? 1 : 0);
                ex.set_fpu_relaxed_stats?.(1);
                ex.set_jit_x87_m80_inline?.(mode);
                ex.set_jit_config?.(10, x87Locals ? 1 : 0);
            };
            apply();
            ex.profiler_init?.();
            cpu.reboot_internal();
            cpu.reset_memory();
            cpu.load_multiboot(buildImage(cw).buffer);
            apply();
            ex.profiler_init?.();
            timer = setTimeout(() => finish("HANG"), 60000);
            emulator.run();
        });
    });
}

const same = (a, b) => a.status === "halt" && b.status === "halt" && a.sw === b.sw && a.cwOut === b.cwOut &&
    a.swEnv === b.swEnv && a.tag === b.tag && a.mem.length === b.mem.length && a.mem.every((v, i) => v === b.mem[i]);
const firstDiff = (a, b) => { for(let i = 0; i < a.mem.length; i++) if(a.mem[i] !== b.mem[i]) return "0x" + (OUT_LO + i).toString(16); return a.sw !== b.sw ? "status" : a.tag !== b.tag ? "tag" : "-"; };

let ok = true;
const say = (cond, text) => { if(!cond) ok = false; console.log(`${cond ? "OK  " : "FAIL"} ${text}`); };

for(const cw of [0x037F, 0x027F, 0x007F])
{
    const tag = `cw=${cw.toString(16)}`;
    const strictInterp = await run(cw, { jit: false, relaxed: false });
    const relaxedInterp = await run(cw, { jit: false, relaxed: true });
    const off = await run(cw, { jit: true, relaxed: true, mode: 0 });
    const on = await run(cw, { jit: true, relaxed: true, mode: 1 });
    const onLocals = await run(cw, { jit: true, relaxed: true, mode: 1, x87Locals: true });
    const onStrict = await run(cw, { jit: true, relaxed: false, mode: 1 });
    const mutated = await run(cw, { jit: true, relaxed: true, mode: 2 });

    say(on.hasSwitch, `${tag} the engine has set_jit_x87_m80_inline`);
    const diffs = [];
    for(let i = 0; i < strictInterp.mem.length; i++) if(strictInterp.mem[i] !== relaxedInterp.mem[i]) diffs.push(OUT_LO + i);
    const aliasOnly = diffs.every(a => [OUTA, OUTD, OUTE].some(b => a >= b + ALIAS * 16 && a < b + ALIAS * 16 + 10) || (a >= OUTB + ALIAS * 8 && a < OUTB + ALIAS * 8 + 8));
    say(relaxedInterp.status === "halt" && aliasOnly && relaxedInterp.tag === strictInterp.tag,
        `${tag} relaxed interpreter = strict interpreter except the 0x7FFE image, which relaxed mode re-expresses on load (${diffs.length} bytes there)`);
    say(same(relaxedInterp, off), `${tag} JIT switch off = interpreter ${firstDiff(relaxedInterp, off)}`);
    say(same(relaxedInterp, on), `${tag} JIT switch on = interpreter ${firstDiff(relaxedInterp, on)}`);
    say(same(relaxedInterp, onLocals), `${tag} JIT switch on + x87 locals = interpreter ${firstDiff(relaxedInterp, onLocals)}`);
    say(same(strictInterp, onStrict), `${tag} JIT switch on, strict FPU = strict interpreter ${firstDiff(strictInterp, onStrict)}`);
    say(on.hit > off.hit, `${tag} inline store taken: relaxed hits ${off.hit} -> ${on.hit}`);
    say(!same(relaxedInterp, mutated), `${tag} negative control (low-bit test dropped) diverges at ${firstDiff(relaxedInterp, mutated)}`);
}
console.log(ok ? "PASS jit-x87-m80-inline-diff" : "FAIL jit-x87-m80-inline-diff");
process.exit(ok ? 0 : 1);
