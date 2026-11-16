#!/usr/bin/env node
// A cycle limit that drops to 0 in the middle of a slice (an urgent exit requested from an
// OUT handler) must end main_loop after the pass that saw it. Before the fix, the outer loop
// kept re-entering do_many_cycles_native, which retired nothing, until TIME_PER_FRAME
// (about 1 ms per call) and then returned 0.0.
//
// The host restores the grant before every main_loop call, as BottleShip's
// prepareForExecution does, so each call is one slice that ends at the guest's OUT.
// The grant is above LOOP_COUNTER: a grant below it takes the preemption exit and hides
// the case.
//
//   node tests/main-loop-cycle-limit-zero.mjs

const { V86 } = await import(process.env.V86_LIB ?? "../build/libv86.mjs");

const BASE = 0x100000;
const ENTRY = BASE + 0x40;
const PORT = 0xE0;
const GRANT = 200_003;
const CALLS = 40;

function buildImage()
{
    const buf = new Uint8Array(0x2000);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002;
    const FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + buf.length, true);
    dv.setUint32(0x18, BASE + buf.length, true);
    dv.setUint32(0x1c, ENTRY, true);

    let o = ENTRY - BASE;
    const emit = (...bytes) => { for(const b of bytes) buf[o++] = b; };
    emit(0xBC, 0x00, 0x00, 0x20, 0x00);     // mov esp, 0x200000
    emit(0x31, 0xC9);                       // xor ecx, ecx
    emit(0xBA, PORT, 0x00, 0x00, 0x00);     // mov edx, PORT
    const outer = o;
    emit(0x41);                             // inc ecx
    emit(0xBB, 0xE8, 0x03, 0x00, 0x00);     // mov ebx, 1000
    const inner = o;
    emit(0x4B);                             // dec ebx
    emit(0x75, (inner - (o + 2)) & 0xff);   // jnz inner
    emit(0xEE);                             // out dx, al
    emit(0xEB, (outer - (o + 2)) & 0xff);   // jmp outer
    return buf;
}

function run(clearLimit)
{
    return new Promise(resolve => {
        const emulator = new V86({
            autostart: false,
            memory_size: 16 * 1024 * 1024,
            disable_jit: 0,
            log_level: 0,
        });
        let timer;
        const rows = [];
        const finish = status => {
            clearTimeout(timer);
            try { emulator.stop(); } catch {}
            resolve({ status, rows });
        };
        emulator.add_listener("emulator-loaded", () => {
            const cpu = emulator.v86.cpu;
            cpu.reboot_internal();
            cpu.reset_memory();
            cpu.load_multiboot(buildImage().buffer);

            const hp = cpu.wm.exports.get_hypercall_page_ptr() >>> 0;
            const page = () => new DataView(cpu.wasm_memory.buffer);
            page().setUint32(hp + 0x008, 1, true);
            let outs = 0;
            cpu.io.register_write(PORT, null, () => {
                outs++;
                if(clearLimit) page().setUint32(hp + 0x000, 0, true);
            });

            const inner = cpu.main_loop;
            cpu.main_loop = () => {
                page().setUint32(hp + 0x000, GRANT, true);
                const ecx0 = cpu.reg32[1] >>> 0;
                const ic0 = cpu.instruction_counter[0] >>> 0;
                const outs0 = outs;
                const t0 = performance.now();
                const ret = inner();
                rows.push({
                    ret,
                    ms: performance.now() - t0,
                    passes: (cpu.reg32[1] >>> 0) - ecx0,
                    retired: ((cpu.instruction_counter[0] >>> 0) - ic0) >>> 0,
                    outs: outs - outs0,
                });
                if(rows.length >= CALLS) setTimeout(() => finish("done"), 0);
                return ret;
            };

            timer = setTimeout(() => finish("TIMEOUT"), 20000);
            emulator.run();
        });
    });
}

const urgent = await run(true);
const control = await run(false);

const tail = r => r.rows.slice(10);
const u = tail(urgent);
const c = tail(control);
const avg = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length);

// One do_many_cycles_native pass retires the grant and stops at the next block boundary.
// The outer loop is 2003 instructions, so a second pass would retire at least that much more.
const onePass = r => r.retired >= GRANT && r.retired < GRANT + 2003;
const okUrgent = urgent.status === "done" && u.length > 0 &&
    u.every(r => r.ret === 0.1 && onePass(r) && r.outs >= 1);
const okControl = control.status === "done" && c.length > 0 &&
    c.every(r => r.ret === 0.0);

console.log(`urgent exit: ${urgent.status}, calls=${urgent.rows.length}, ret=${[...new Set(u.map(r => r.ret))].join("/")}, ` +
    `passes per call=${[...new Set(u.map(r => r.passes))].join("/")}, retired per call=${[...new Set(u.map(r => r.retired))].join("/")}, avg ${avg(u, r => r.ms).toFixed(3)} ms per call`);
console.log(`control (limit kept): ${control.status}, ret=${[...new Set(c.map(r => r.ret))].join("/")}, ` +
    `avg passes per call=${avg(c, r => r.passes).toFixed(0)}, avg ${avg(c, r => r.ms).toFixed(3)} ms per call`);
console.log(`${okUrgent && okControl ? "PASS" : "FAIL"} main-loop-cycle-limit-zero`);
process.exit(okUrgent && okControl ? 0 : 1);
