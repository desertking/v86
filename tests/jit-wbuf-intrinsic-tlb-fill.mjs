#!/usr/bin/env node
// A WBUF intrinsic call that is accepted leaves the TLB holding the pages it touched, so the
// next call takes the TLB fast path instead of a page walk (shown by revoking the control
// page's PTE without INVLPG: a TLB hit still accepts, a walk declines); a declined call leaves
// neither TLB entries nor accessed/dirty bits behind.
//
//   node tests/jit-wbuf-intrinsic-tlb-fill.mjs   [V86_WASM_PATH=<candidate v86.wasm>]

const { V86 } = await import("../build/libv86.mjs");

const BASE = 0x100000;
const ENTRY = BASE + 0x40;
const TARGET = BASE + 0x1000;      // canonical trampoline, registered as a scalar WBUF stub
const CONST_TARGET = TARGET + 0x100;
const PD_ADDR = 0x108000, PT0_ADDR = 0x109000;
const CTRL = 0x180000;
const STACK = 0x190000;
const DATA = 0x200000, CAPACITY = 0x100000;
const ARGS = 0x310000;             // synthetic pre-CALL frame for the JS-driven calls
const CONST_OK = 0x320FF0;         // spans 0x320/0x321 — both present
const CONST_BAD = 0x330FF0;        // spans 0x330 (present) and HOLE_PAGE
const HOLE_PAGE = 0x331000;
const VEC4 = 16, PAYLOAD = VEC4 * 16, STRIDE = 16 + PAYLOAD;
const ITER = 100000;
const MEM_SIZE = 16 * 1024 * 1024;
const TIMEOUT_MS = 30000;

function build_image()
{
    const size = 0x1100;
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

    // Identity-map 0..4MB with 4KB pages, then punch out exactly one page.
    emit(0xFC);                                    // cld
    emit(0xBF); u32(PT0_ADDR);                     // mov edi,PT0
    emit(0xB8); u32(0x00000003);                   // mov eax,0|P|RW
    emit(0xB9); u32(0x400);                        // mov ecx,1024
    const fill = o;
    emit(0xAB);                                    // stosd
    emit(0x05); u32(0x1000);                       // add eax,0x1000
    emit(0xE2, (fill - (o + 2)) & 0xFF);           // loop fill
    emit(0xC7, 0x05); u32(PT0_ADDR + (HOLE_PAGE >>> 12) * 4); u32(0); // PTE[hole] <- not present
    emit(0xBF); u32(PD_ADDR);                      // mov edi,PD
    emit(0x31, 0xC0);                              // xor eax,eax
    emit(0xB9); u32(0x400);                        // mov ecx,1024
    emit(0xF3, 0xAB);                              // rep stosd
    emit(0xC7, 0x05); u32(PD_ADDR); u32((PT0_ADDR | 3) >>> 0);
    emit(0xB8); u32(PD_ADDR);                      // mov eax,PD
    emit(0x0F, 0x22, 0xD8);                        // mov cr3,eax
    emit(0x0F, 0x20, 0xC0);                        // mov eax,cr0
    emit(0x0D); u32(0x80000000);                   // or eax,0x80000000
    emit(0x0F, 0x22, 0xC0);                        // mov cr0,eax

    emit(0xBC); u32(STACK);                        // mov esp,STACK
    emit(0xB9); u32(ITER);                         // mov ecx,ITER
    emit(0xBF); u32(TARGET);                       // mov edi,TARGET
    label("loop");
    emit(0x68); u32(0x12345678);                   // push arg
    emit(0xFF, 0xD7);                              // call edi
    emit(0x49);                                    // dec ecx
    emit(0x0F, 0x85); rel32("loop");               // jnz loop
    emit(0xF4, 0xEB, 0xFE);                        // hlt; jmp $

    o = TARGET - BASE;
    emit(0x9C);                                    // pushfd
    emit(0xB8); u32(0);                            // mov eax,0
    emit(0xBA); u32(0xB077);                       // mov edx,0xB077
    emit(0x9D);                                    // popfd
    emit(0xC2, 0x04, 0x00);                        // ret 4

    for(const p of patches) dv.setInt32(p.at, labels[p.name] - p.end, true);
    return buf;
}

const fail = message => { throw new Error(message); };

function run()
{
    return new Promise((resolve, reject) => {
        const emulator = new V86({
            autostart: false, memory_size: MEM_SIZE, disable_jit: 0, log_level: 0,
            wasm_path: process.env.V86_WASM_PATH || undefined,
        });
        let timer;
        emulator.bus.register("cpu-event-halt", () => {
            clearTimeout(timer);
            try { resolve(after_halt(emulator)); }
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
                if(!ex.jit_wbuf_intrinsic_register(TARGET, 0x44, 0, 1, 1, CTRL, DATA, CAPACITY))
                    fail("scalar registration failed");
                if(!ex.jit_wbuf_intrinsic_mark_hot(0, TARGET)) fail("scalar mark_hot failed");
                dv.setUint32(CTRL, 0, true);

                cpu.jit_clear_cache?.();
                cpu.load_multiboot(build_image().buffer);
                timer = setTimeout(() => reject(new Error("guest did not halt")), TIMEOUT_MS);
                emulator.run();
            }
            catch(error) { reject(error); }
        });
    });
}

function after_halt(emulator)
{
    const cpu = emulator.v86.cpu;
    const ex = cpu.wm.exports;
    const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.byteLength);
    const pte = addr => PT0_ADDR + (addr >>> 12) * 4;
    const AD = 0x60;
    const pages = [CTRL, DATA, ARGS, CONST_BAD];
    const reset = () => {
        for(const p of pages) dv.setUint32(pte(p), dv.getUint32(pte(p), true) & ~AD, true);
        ex.full_clear_tlb();
    };
    const ad = addr => dv.getUint32(pte(addr), true) & AD;
    const result = { paging: (cpu.cr[0] >>> 0) & 0x80000000 ? 1 : 0 };

    if(!ex.jit_wbuf_intrinsic_register(CONST_TARGET, 0x55, 1, 4, 1, CTRL, DATA, CAPACITY))
        fail("shader-constant registration failed");

    reset();
    dv.setUint32(CTRL, 0, true);
    dv.setUint32(ARGS, 0xABCD0001, true);
    result.first_cleanup = ex.jit_wbuf_intrinsic_execute(TARGET, ARGS) | 0;
    result.ctrl_ad = ad(CTRL);
    result.data_ad = ad(DATA);
    result.args_ad = ad(ARGS);
    result.first_word = dv.getUint32(DATA + 4, true);
    const ctrl_pte = dv.getUint32(pte(CTRL), true);
    dv.setUint32(pte(CTRL), 0, true);
    result.second_cleanup = ex.jit_wbuf_intrinsic_execute(TARGET, ARGS) | 0;
    dv.setUint32(pte(CTRL), ctrl_pte, true);
    result.head = dv.getUint32(CTRL, true);

    reset();
    dv.setUint32(CTRL, 0x2000, true);
    dv.setUint32(ARGS + 0, 0x11112222, true);
    dv.setUint32(ARGS + 4, 7, true);
    dv.setUint32(ARGS + 8, CONST_BAD, true);
    dv.setUint32(ARGS + 12, VEC4, true);
    result.bad_cleanup = ex.jit_wbuf_intrinsic_execute(CONST_TARGET, ARGS) | 0;
    result.bad_ad = pages.map(ad);
    result.bad_head = dv.getUint32(CTRL, true);
    const clean_ctrl_pte = dv.getUint32(pte(CTRL), true);
    dv.setUint32(pte(CTRL), 0, true);
    dv.setUint32(ARGS + 8, CONST_OK, true);
    result.after_bad_cleanup = ex.jit_wbuf_intrinsic_execute(CONST_TARGET, ARGS) | 0;
    dv.setUint32(pte(CTRL), clean_ctrl_pte, true);
    return result;
}

const r = await run();
console.log("jit-wbuf-intrinsic-tlb-fill " + JSON.stringify(r));
if(!r.paging) fail("guest did not enable paging");
if(r.first_cleanup !== 4 || r.second_cleanup !== 4 || r.head !== 16) fail("accepted calls did not encode");
if(r.first_word !== 0xABCD0001) fail("argument was not copied");
if(r.second_cleanup !== 4) fail("second call walked the page table instead of using the TLB entry the first call left");
if(r.ctrl_ad !== 0x60 || r.data_ad !== 0x60) fail("written pages are not accessed+dirty");
if((r.args_ad & 0x20) === 0) fail("read stack page is not accessed");
if(r.bad_cleanup !== -1 || r.bad_head !== 0x2000) fail("non-present constant block was executed");
if(r.after_bad_cleanup !== -1) fail("declined call filled the TLB");
if(r.bad_ad.some(x => x !== 0)) fail("declined call set accessed/dirty bits");
console.log("  ok — accepted calls fill the TLB once, declines leave no trace");
