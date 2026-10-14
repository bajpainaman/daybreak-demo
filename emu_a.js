// Daybreak ISA v1 emulator (emu_a). Single ES module, no dependencies.

const MEM_SIZE = 0x100000;
const MEM_LAST = MEM_SIZE - 1;
const FRAME_BYTES = 8192;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class Machine {
  constructor(image) {
    if (!(image instanceof Uint8Array)) throw new TypeError("image must be a Uint8Array");
    if (image.length > MEM_SIZE) throw new RangeError(`image is ${image.length} bytes; max ${MEM_SIZE}`);
    this._mem = new Uint8Array(MEM_SIZE);
    this._mem.set(image, 0);
    this._m32 = new Int32Array(this._mem.buffer);
    this._r = new Int32Array(16);
    this._pc = 0;
    this._halted = false;
    this._trap = null;
    this._steps = 0;
    this.onFrame = null;
  }

  get pc() { return this._pc >>> 0; }
  get halted() { return this._halted; }
  get trap() { return this._trap; }
  get steps() { return this._steps; }

  reg(i) {
    if (!Number.isInteger(i) || i < 0 || i > 15) throw new RangeError(`bad register index ${i}`);
    return this._r[i] >>> 0;
  }

  readByte(addr) {
    if (!Number.isInteger(addr) || addr < 0 || addr > MEM_LAST) throw new RangeError(`bad address ${addr}`);
    return this._mem[addr];
  }

  step() {
    this._exec(1);
  }

  run(maxSteps) {
    return this._exec(maxSteps === undefined ? Infinity : maxSteps);
  }

  // Executes up to `limit` instructions; returns how many executed (traps included).
  // State is kept in locals and written back on exit so the loop stays tight.
  _exec(limit) {
    if (this._halted) return 0;
    const m = this._mem, m32 = this._m32, r = this._r;
    let pc = this._pc >>> 0;
    let n = 0, done = 0; // done = executed steps already added to this._steps
    let trap = null, halted = false;
    while (n < limit) {
      n++;
      // Fetch: alignment before bounds.
      if ((pc & 3) !== 0) { trap = "MISALIGNED"; halted = true; break; }
      if (pc > MEM_LAST - 3) { trap = "BAD_ADDRESS"; halted = true; break; }
      const w = LITTLE_ENDIAN ? m32[pc >>> 2]
        : (m[pc] | (m[pc + 1] << 8) | (m[pc + 2] << 16) | (m[pc + 3] << 24));
      const op = w >>> 26;
      const rd = (w >>> 22) & 15;
      const ra = (w >>> 18) & 15;
      const next = (pc + 4) >>> 0;
      switch (op) {
        case 0x00: // HALT
          if ((w & 0x3FFFFFF) !== 0) { trap = "ILLEGAL"; halted = true; break; }
          halted = true;
          break;
        case 0x01: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] + r[(w >>> 14) & 15]; pc = next; break;
        case 0x02: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] - r[(w >>> 14) & 15]; pc = next; break;
        case 0x03: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] & r[(w >>> 14) & 15]; pc = next; break;
        case 0x04: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] | r[(w >>> 14) & 15]; pc = next; break;
        case 0x05: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] ^ r[(w >>> 14) & 15]; pc = next; break;
        case 0x06: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] << (r[(w >>> 14) & 15] & 31); pc = next; break;
        case 0x07: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] >>> (r[(w >>> 14) & 15] & 31); pc = next; break;
        case 0x08: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] >> (r[(w >>> 14) & 15] & 31); pc = next; break;
        case 0x09: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = Math.imul(r[ra], r[(w >>> 14) & 15]); pc = next; break;
        case 0x0A: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] < r[(w >>> 14) & 15] ? 1 : 0; pc = next; break;
        case 0x0B: if (w & 0x3FFF) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = (r[ra] >>> 0) < (r[(w >>> 14) & 15] >>> 0) ? 1 : 0; pc = next; break;
        case 0x10: r[rd] = r[ra] + ((w << 14) >> 14); pc = next; break;
        case 0x11: r[rd] = r[ra] & (w & 0x3FFFF); pc = next; break;
        case 0x12: r[rd] = r[ra] | (w & 0x3FFFF); pc = next; break;
        case 0x13: r[rd] = r[ra] ^ (w & 0x3FFFF); pc = next; break;
        case 0x14: if (w & 0x3FFE0) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] << (w & 31); pc = next; break;
        case 0x15: if (w & 0x3FFE0) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] >>> (w & 31); pc = next; break;
        case 0x16: if (w & 0x3FFE0) { trap = "ILLEGAL"; halted = true; break; }
          r[rd] = r[ra] >> (w & 31); pc = next; break;
        case 0x18: r[rd] = w << 10; pc = next; break; // op and rd bits shift out
        case 0x20: { // LDW
          const a = (r[ra] + ((w << 14) >> 14)) >>> 0;
          if (a & 3) { trap = "MISALIGNED"; halted = true; break; }
          if (a > MEM_LAST - 3) { trap = "BAD_ADDRESS"; halted = true; break; }
          r[rd] = LITTLE_ENDIAN ? m32[a >>> 2]
            : (m[a] | (m[a + 1] << 8) | (m[a + 2] << 16) | (m[a + 3] << 24));
          pc = next; break;
        }
        case 0x21: { // LDB
          const a = (r[ra] + ((w << 14) >> 14)) >>> 0;
          if (a > MEM_LAST) { trap = "BAD_ADDRESS"; halted = true; break; }
          r[rd] = m[a]; pc = next; break;
        }
        case 0x22: { // STW
          const a = (r[ra] + ((w << 14) >> 14)) >>> 0;
          if (a & 3) { trap = "MISALIGNED"; halted = true; break; }
          if (a > MEM_LAST - 3) { trap = "BAD_ADDRESS"; halted = true; break; }
          const v = r[rd];
          if (LITTLE_ENDIAN) m32[a >>> 2] = v;
          else { m[a] = v; m[a + 1] = v >>> 8; m[a + 2] = v >>> 16; m[a + 3] = v >>> 24; }
          pc = next; break;
        }
        case 0x23: { // STB
          const a = (r[ra] + ((w << 14) >> 14)) >>> 0;
          if (a > MEM_LAST) { trap = "BAD_ADDRESS"; halted = true; break; }
          m[a] = r[rd]; pc = next; break;
        }
        case 0x28: pc = r[rd] === r[ra] ? (next + (((w << 14) >> 14) << 2)) >>> 0 : next; break;
        case 0x29: pc = r[rd] !== r[ra] ? (next + (((w << 14) >> 14) << 2)) >>> 0 : next; break;
        case 0x2A: pc = r[rd] < r[ra] ? (next + (((w << 14) >> 14) << 2)) >>> 0 : next; break;
        case 0x2B: pc = r[rd] >= r[ra] ? (next + (((w << 14) >> 14) << 2)) >>> 0 : next; break;
        case 0x30: // JAL
          r[rd] = next;
          pc = (next + (((w << 10) >> 10) << 2)) >>> 0;
          break;
        case 0x31: { // JALR: target from old R[ra]
          const t = (r[ra] + ((w << 14) >> 14)) >>> 0;
          r[rd] = next;
          pc = t;
          break;
        }
        case 0x38: { // FRAME
          if (w & 0x03C3FFFF) { trap = "ILLEGAL"; halted = true; break; }
          const a = r[ra] >>> 0;
          if (a > MEM_SIZE - FRAME_BYTES) { trap = "BAD_ADDRESS"; halted = true; break; }
          pc = next;
          const cb = this.onFrame;
          if (cb !== null && cb !== undefined) {
            r[0] = 0;
            this._pc = pc; this._steps += n - done; done = n; // callback may inspect machine state
            cb(m.slice(a, a + FRAME_BYTES));
            // The callback may have stepped the machine re-entrantly; resync from it.
            if (this._halted) return n;
            pc = this._pc;
          }
          break;
        }
        default:
          trap = "ILLEGAL"; halted = true;
      }
      r[0] = 0;
      if (halted) break;
    }
    this._pc = pc;
    this._steps += n - done;
    if (halted) { this._halted = true; this._trap = trap; }
    return n;
  }
}
