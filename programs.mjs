// Random Daybreak programs for the cross-check, and the state comparison it uses. Browser-safe:
// the page runs the same checks the command-line campaign does.

const DATA = 0x8000;  // registers point near here so loads and stores mostly land in memory
const CODE_WORDS = 192;
// Addresses where the spec's rules change: the end of memory, the last base FRAME can use,
// 32-bit wrap-around, and the program's own code (stores there are self-modifying).
const EDGES = [0xffffc, 0x100000, 0xfe000, 0xfdfff, 0xffffffff, 0xfffffffc, 0x80000000, 0, 64, 0x7fffc];
export const MAX_STEPS = 4000;
const R = ["ADD", "SUB", "AND", "OR", "XOR", "SHL", "SHR", "SAR", "MUL", "SLT", "SLTU"];
const OP = { HALT: 0x00, ADD: 0x01, SUB: 0x02, AND: 0x03, OR: 0x04, XOR: 0x05, SHL: 0x06, SHR: 0x07, SAR: 0x08,
  MUL: 0x09, SLT: 0x0a, SLTU: 0x0b, ADDI: 0x10, ANDI: 0x11, ORI: 0x12, XORI: 0x13, SHLI: 0x14, SHRI: 0x15,
  SARI: 0x16, LUI: 0x18, LDW: 0x20, LDB: 0x21, STW: 0x22, STB: 0x23, BEQ: 0x28, BNE: 0x29, BLT: 0x2a, BGE: 0x2b,
  JAL: 0x30, JALR: 0x31, FRAME: 0x38 };

// xorshift32 for reproducible programs
function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { u32: next, int: (n) => next() % n, pick: (a) => a[next() % a.length], chance: (p) => next() / 2 ** 32 < p };
}

const enc = {
  r: (op, rd, ra, rb) => ((op << 26) | (rd << 22) | (ra << 18) | (rb << 14)) >>> 0,
  i: (op, rd, ra, imm) => ((op << 26) | (rd << 22) | (ra << 18) | (imm & 0x3ffff)) >>> 0,
  u: (op, rd, imm) => ((op << 26) | (rd << 22) | (imm & 0x3fffff)) >>> 0,
};

export function program(seed) {
  const g = rng(seed * 2654435761);
  const words = [];
  const reg = () => g.int(16);
  // Prologue: give r1..r13 interesting values, some of them addresses near DATA.
  for (let r = 1; r < 14; r++) {
    // Mostly full-range values: products and shifts of small numbers never reach the high
    // bits, which is where a float-based MUL or a signed/unsigned slip shows up.
    const roll = g.int(10);
    const v = roll < 3 ? DATA + 4 * g.int(256) + (g.chance(0.1) ? g.int(4) : 0)
      : roll < 5 ? g.pick(EDGES) + g.int(9) - 4  // straddle the spec's boundaries
      : roll < 9 ? g.u32()
      : g.pick([g.int(64), -g.int(64) >>> 0, 0x80000000, 0x7fffffff, 0xffffffff, 32, 33, 31, 63]);
    words.push(enc.u(OP.LUI, r, v >>> 10), enc.i(OP.ORI, r, r, v & 0x3ff));
  }
  const body = CODE_WORDS - words.length - 1;
  for (let k = 0; k < body; k++) {
    const left = body - k;
    const roll = g.int(100);
    let w;
    if (roll < 30) w = enc.r(OP[g.pick(R)], reg(), reg(), reg());
    else if (roll < 45) {
      const op = g.pick(["ADDI", "ANDI", "ORI", "XORI"]);
      w = enc.i(OP[op], reg(), reg(), g.chance(0.5) ? g.int(64) - 32 : g.u32());
    } else if (roll < 52) w = enc.i(OP[g.pick(["SHLI", "SHRI", "SARI"])], reg(), reg(), g.chance(0.95) ? g.int(32) : g.u32());
    else if (roll < 55) w = enc.u(OP.LUI, reg(), g.u32());
    else if (roll < 70) {
      const op = g.pick(["LDW", "LDB", "STW", "STB"]);
      w = enc.i(OP[op], reg(), reg(), g.chance(0.9) ? 4 * g.int(32) - 64 + (g.chance(0.1) ? g.int(4) : 0) : g.u32());
    } else if (roll < 84) {
      const off = g.chance(0.7) ? -g.int(Math.min(k + 1, 12)) - 1 : g.int(Math.min(left, 12));  // short loops
      w = enc.i(OP[g.pick(["BEQ", "BNE", "BLT", "BGE"])], reg(), reg(), off);
    } else if (roll < 88) w = enc.u(OP.JAL, g.chance(0.5) ? 0 : reg(), g.int(Math.min(left, 8)));
    else if (roll < 90) w = enc.i(OP.JALR, reg(), reg(), g.int(64) - 32);
    else if (roll < 92) w = enc.r(OP.FRAME, 0, reg(), 0);
    else if (roll < 95) w = g.u32();  // raw word: probes illegal encodings and must-be-zero bits
    else w = (g.u32() & ~(0x3f << 26) | (g.pick(Object.values(OP)) << 26)) >>> 0;  // legal opcode, random fields
    words.push(w);
  }
  words.push(enc.r(OP.HALT, 0, 0, 0));
  const image = new Uint8Array(DATA + 1024);
  new DataView(image.buffer).setUint32(0, 0);
  words.forEach((w, i) => new DataView(image.buffer).setUint32(4 * i, w, true));
  for (let i = DATA; i < image.length; i++) image[i] = g.int(256);
  return image;
}

export function state(m) {
  const regs = [];
  for (let i = 0; i < 16; i++) regs.push(m.reg(i));
  return { pc: m.pc, halted: m.halted, trap: m.trap, steps: m.steps, regs };
}

export function diff(sa, sb) {
  const out = [];
  for (const k of ["pc", "halted", "trap", "steps"]) if (sa[k] !== sb[k]) out.push(`${k}: A=${sa[k]} B=${sb[k]}`);
  sa.regs.forEach((v, i) => { if (v !== sb.regs[i]) out.push(`r${i}: A=0x${v.toString(16)} B=0x${sb.regs[i].toString(16)}`); });
  return out;
}
