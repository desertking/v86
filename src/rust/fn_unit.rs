#![allow(static_mut_refs)]

// Function units: the baseline oracle for a function tier. Default OFF.
//
// A unit is one census row made executable: an M1 row (no unit refusal, clean static window,
// a known return form) compiled from its entry by the page JIT's own emitter, with the block
// walk held to the row's code pages and runs. It has exactly one entry, the function start,
// and keeps canonical CPU state at every boundary: it leaves through the emitter's ordinary
// exits with the exact EIP. A RET that lands on the return address pushed at entry, with the
// recorded `ret imm16` applied to ESP, is MATCHED; every other exit is EXITED and the
// dispatcher continues at that EIP.
//
// Units live in a dispatcher-owned table keyed by the virtual entry. Each entry has a
// generation. A write to any page of a unit (the existing jit_dirty_page path, reached through
// the TLB has-code bit the unit sets on its pages) bumps the generation, frees the table slot
// and drops the unit. A compile records the generation it started under; a write during the
// asynchronous compile makes the finished module stale and it is freed instead of published.
// The dispatcher enters a unit only at the current generation and the unit's state flags.
//
// Off, the dispatcher pays one load and one untaken branch; page modules, the codegen
// fingerprint and the census are unchanged. The mutation switch exists only for the negative
// controls in tests/jit-fn-unit.mjs.

use crate::jit::{FixedHasher, WasmTableIndex};
use crate::page::Page;
use crate::state_flags::CachedStateFlags;
use std::collections::HashMap;

pub const SCHEMA_VERSION: u32 = 1;

pub const S_ENTRIES: usize = 0;
pub const S_MATCHED: usize = 1;
pub const S_EXITED: usize = 2;
pub const S_COMPILES: usize = 3;
pub const S_PUBLISHED: usize = 4;
pub const S_WRITTEN_DURING_COMPILE: usize = 5;
pub const S_COMPILE_FAILED: usize = 6;
pub const S_INVALIDATED: usize = 7;
pub const S_REFUSE_NOT_M1: usize = 8;
pub const S_REFUSE_RET_FORM: usize = 9;
pub const S_REFUSE_SHAPE: usize = 10;
pub const S_REFUSE_STATE: usize = 11;
pub const S_REFUSE_PHYS: usize = 12;
pub const S_REFUSE_STALE_ROW: usize = 13;
pub const S_DEFERRED_BUSY: usize = 14;
pub const S_SKIP_STACK: usize = 15;
pub const S_SKIP_GENERATION: usize = 16;
pub const S_SKIP_MAPPING: usize = 17;
pub const S_SKIP_STATE: usize = 18;
pub const S_INSNS: usize = 19;
pub const STAT_COUNT: usize = 20;

pub const M_NO_INVALIDATION: u32 = 1 << 0;
pub const M_NO_GENERATION_CHECK: u32 = 1 << 1;
pub const M_RESUME_AFTER_EXIT: u32 = 1 << 2;

static mut ENABLED: bool = false;
static mut MUTATION: u32 = 0;
static mut THRESHOLD: u32 = 16;
static mut STATS: [f64; STAT_COUNT] = [0.0; STAT_COUNT];

pub struct Unit {
    pub phys: u32,
    pub index: WasmTableIndex,
    pub state: u16,
    pub generation: u32,
    pub state_flags: CachedStateFlags,
    pub pages: Vec<Page>,
    pub ret_imm: u32,
}

pub struct Pending {
    pub virt: u32,
    pub phys: u32,
    pub state: u16,
    pub generation: u32,
    pub state_flags: CachedStateFlags,
    pub pages: Vec<Page>,
    pub ret_imm: u32,
}

pub struct Units {
    pub units: HashMap<u32, Unit, FixedHasher>,
    pub generations: HashMap<u32, u32, FixedHasher>,
    pub page_entries: HashMap<Page, Vec<u32>, FixedHasher>,
    pub refused: HashMap<u32, u32, FixedHasher>,
    pub pending: Option<Pending>,
}

impl Units {
    pub fn new() -> Units {
        Units {
            units: HashMap::default(),
            generations: HashMap::default(),
            page_entries: HashMap::default(),
            refused: HashMap::default(),
            pending: None,
        }
    }

    pub fn generation(&self, virt: u32) -> u32 { *self.generations.get(&virt).unwrap_or(&0) }

    pub fn track_pages(&mut self, virt: u32, pages: &[Page]) {
        for &p in pages {
            let v = self.page_entries.entry(p).or_insert_with(Vec::new);
            if !v.contains(&virt) {
                v.push(virt);
            }
        }
    }

    /// A write reached `page`. Returns the table slots to free.
    pub fn note_page_dirty(&mut self, page: Page) -> Vec<WasmTableIndex> {
        let mut freed = Vec::new();
        if mutation(M_NO_INVALIDATION) {
            return freed;
        }
        let entries = match self.page_entries.remove(&page) {
            Some(v) => v,
            None => return freed,
        };
        for virt in entries {
            let g = self.generations.entry(virt).or_insert(0);
            *g = g.wrapping_add(1);
            self.refused.remove(&virt);
            if let Some(u) = self.units.remove(&virt) {
                stat_add(S_INVALIDATED, 1.0);
                for p in &u.pages {
                    if *p != page {
                        if let Some(v) = self.page_entries.get_mut(p) {
                            v.retain(|&x| x != virt);
                        }
                    }
                }
                freed.push(u.index);
            }
        }
        freed
    }

    pub fn take_all(&mut self) -> Vec<WasmTableIndex> {
        let freed = self.units.drain().map(|(_, u)| u.index).collect();
        for g in self.generations.values_mut() {
            *g = g.wrapping_add(1);
        }
        if let Some(p) = &self.pending {
            let g = self.generations.entry(p.virt).or_insert(0);
            *g = g.wrapping_add(1);
        }
        self.page_entries = HashMap::default();
        self.refused = HashMap::default();
        freed
    }
}

#[inline]
pub fn enabled() -> bool { unsafe { ENABLED } }

pub fn mutation(bit: u32) -> bool { unsafe { MUTATION & bit != 0 } }

pub fn threshold() -> u32 { unsafe { THRESHOLD } }

pub fn stat_add(i: usize, n: f64) { unsafe { STATS[i] += n } }

pub fn set_enabled(on: bool) { unsafe { ENABLED = on } }

#[no_mangle]
pub fn fn_unit_version() -> u32 { SCHEMA_VERSION }

#[no_mangle]
pub fn fn_unit_set_threshold(n: u32) { unsafe { THRESHOLD = n.max(1) } }

#[no_mangle]
pub fn fn_unit_get_threshold() -> u32 { threshold() }

#[no_mangle]
pub fn fn_unit_set_mutation(bits: u32) { unsafe { MUTATION = bits } }

#[no_mangle]
pub fn fn_unit_get_mutation() -> u32 { unsafe { MUTATION } }

#[no_mangle]
pub fn fn_unit_stat(i: u32) -> f64 {
    unsafe { if (i as usize) < STAT_COUNT { STATS[i as usize] } else { 0.0 } }
}

#[no_mangle]
pub fn fn_unit_stat_count() -> u32 { STAT_COUNT as u32 }

pub fn reset_stats() { unsafe { STATS = [0.0; STAT_COUNT] } }
