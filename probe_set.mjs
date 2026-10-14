// The interface probes: the places SPEC.md could be read two ways. Each probe takes a Machine
// class and returns what it observed; two emulators agree if the results are equal as JSON.
// Browser-safe.

const enc = {
  r: (op, rd, ra, rb, low = 0) => ((op << 26) | (rd << 22) | (ra << 18) | (rb << 14) | low) >>> 0,
  i: (op, rd, ra, imm) => ((op << 26) | (rd << 22) | (ra << 18) | (imm & 0x3ffff)) >>> 0,
  u: (op, rd, imm) => ((op << 26) | (rd << 22) | (imm & 0x3fffff)) >>> 0,
};
const LUI = 0x18, ORI = 0x12, ADDI = 0x10, FRAME = 0x38, HALT = 0, JAL = 0x30, JALR = 0x31, LDW = 0x20, STW = 0x22, BEQ = 0x28;
const li = (r, v) => [enc.u(LUI, r, v >>> 10), enc.i(ORI, r, r, v & 0x3ff)];
const img = (...words) => {
  const flat = words.flat();
  const u8 = new Uint8Array(4 * flat.length);
  flat.forEach((w, i) => new DataView(u8.buffer).setUint32(4 * i, w, true));
  return u8;
};

export function outcome(f) {
  try { return { value: f() }; } catch (e) { return { threw: e.constructor.name }; }
}
const snap = (m) => {
  const r = [];
  for (let i = 0; i < 16; i++) r.push(m.reg(i));
  return { pc: m.pc, halted: m.halted, trap: m.trap, steps: m.steps, regs: r.join(",") };
};

export const PROBES = {
  "inside onFrame: pc and steps": (M) => {
    const m = new M(img(li(1, 0x1000), enc.r(FRAME, 0, 1, 0), enc.r(HALT, 0, 0, 0)));
    let seen = null;
    m.onFrame = () => { seen = { pc: m.pc, steps: m.steps }; };
    m.run(10);
    return { seen, after: snap(m) };
  },
  "onFrame throws": (M) => {
    const m = new M(img(li(1, 0x1000), enc.r(FRAME, 0, 1, 0), enc.r(HALT, 0, 0, 0)));
    m.onFrame = () => { throw new Error("boom"); };
    const r = outcome(() => m.run(10));
    return { r, after: snap(m) };
  },
  "FRAME with nonzero low bits": (M) => {
    const m = new M(img(li(1, 0x1000), enc.r(FRAME, 0, 1, 0, 1), enc.r(HALT, 0, 0, 0)));
    let frames = 0;
    m.onFrame = () => frames++;
    m.run(10);
    return { frames, after: snap(m) };
  },
  "FRAME at the last legal base, and one past it": (M) => {
    const out = [];
    for (const base of [0xfe000, 0xfe001, 0xffffffff]) {
      const m = new M(img(li(1, base), enc.r(FRAME, 0, 1, 0), enc.r(HALT, 0, 0, 0)));
      let frames = 0;
      m.onFrame = () => frames++;
      m.run(10);
      out.push({ base, frames, ...snap(m) });
    }
    return out;
  },
  "HALT with a nonzero low bit": (M) => { const m = new M(img(enc.r(HALT, 0, 0, 0, 1))); m.run(5); return snap(m); },
  "HALT counts as a step, pc stays": (M) => { const m = new M(img(enc.r(HALT, 0, 0, 0))); m.run(5); m.step(); return snap(m); },
  "jump to a misaligned target": (M) => { const m = new M(img(li(1, 0x102), enc.i(JALR, 2, 1, 0))); m.run(10); return snap(m); },
  "jump past the end of memory": (M) => { const m = new M(img(li(1, 0x100000), enc.i(JALR, 2, 1, 0))); m.run(10); return snap(m); },
  "JALR rd == ra": (M) => { const m = new M(img(li(1, 0x10), enc.i(JALR, 1, 1, 0), enc.r(HALT, 0, 0, 0), enc.r(HALT, 0, 0, 0), enc.r(HALT, 0, 0, 0))); m.run(10); return snap(m); },
  "word straddling the end of memory": (M) => { const m = new M(img(li(1, 0xffffe), enc.i(LDW, 2, 1, 0))); m.run(10); return snap(m); },
  "misaligned and out of bounds at once": (M) => { const m = new M(img(li(1, 0x100001), enc.i(LDW, 2, 1, 0))); m.run(10); return snap(m); },
  "address wraps below zero": (M) => { const m = new M(img(enc.i(LDW, 2, 0, -4))); m.run(10); return snap(m); },
  "self-modifying code": (M) => {
    // overwrite the HALT at word 4 with ADDI r5, r0, 7 and fall into it
    const patch = enc.i(ADDI, 5, 0, 7);
    const m = new M(img(li(1, patch), enc.i(STW, 1, 0, 16), enc.r(0x01, 0, 0, 0), enc.r(HALT, 0, 0, 0), enc.r(HALT, 0, 0, 0)));
    m.run(20);
    return snap(m);
  },
  "branch to itself (offset -1)": (M) => { const m = new M(img(enc.i(BEQ, 0, 0, -1))); return { ran: m.run(100), ...snap(m) }; },
  "JAL with the largest negative offset": (M) => { const m = new M(img(enc.u(JAL, 3, 0x200000))); m.run(5); return snap(m); },
  "run(0), run(-1), run on a halted machine": (M) => {
    const m = new M(img(enc.r(HALT, 0, 0, 0)));
    return { zero: outcome(() => m.run(0)), neg: outcome(() => m.run(-1)), one: outcome(() => m.run(1)), again: outcome(() => m.run(5)), after: snap(m) };
  },
  "reg(16), reg(-1), readByte(0x100000)": (M) => {
    const m = new M(img(enc.r(HALT, 0, 0, 0)));
    return { r16: outcome(() => m.reg(16)), rneg: outcome(() => m.reg(-1)), past: outcome(() => m.readByte(0x100000)) };
  },
  "image larger than memory": (M) => outcome(() => { new M(new Uint8Array((1 << 20) + 1)); return "constructed"; }),
  "empty image": (M) => { const m = new M(new Uint8Array(0)); m.run(5); return snap(m); },
  "run() with no argument": (M) => {
    const m = new M(img(enc.i(ADDI, 1, 1, 1), enc.i(ADDI, 1, 1, 1), enc.r(HALT, 0, 0, 0)));
    return { ran: outcome(() => m.run()), after: snap(m) };
  },
  "onFrame calls step() on the same machine": (M) => {
    const m = new M(img(li(1, 0x1000), enc.r(FRAME, 0, 1, 0), enc.i(ADDI, 2, 2, 5), enc.i(ADDI, 2, 2, 5), enc.r(HALT, 0, 0, 0)));
    let inner = null;
    m.onFrame = () => { if (!inner) { m.step(); inner = snap(m); } };
    const r = outcome(() => m.run(20));
    return { r, inner, after: snap(m) };
  },
  "onFrame calls run() on the same machine": (M) => {
    const m = new M(img(li(1, 0x1000), enc.r(FRAME, 0, 1, 0), enc.i(ADDI, 2, 2, 5), enc.r(FRAME, 0, 1, 0), enc.i(ADDI, 2, 2, 5), enc.r(HALT, 0, 0, 0)));
    let calls = 0;
    m.onFrame = () => { calls++; if (calls === 1) m.run(2); };
    const r = outcome(() => m.run(5));
    return { r, calls, after: snap(m) };
  },
  "onFrame gets a fresh copy": (M) => {
    const m = new M(img(li(1, 0x1000), enc.r(FRAME, 0, 1, 0), enc.r(FRAME, 0, 1, 0), enc.r(HALT, 0, 0, 0)));
    const got = [];
    m.onFrame = (px) => { got.push(px); px[0] = 99; };
    m.run(10);
    return { distinct: got.length === 2 && got[0] !== got[1], second0: got[1]?.[0], len: got[0]?.length, mem: m.readByte(0x1000) };
  },
};
