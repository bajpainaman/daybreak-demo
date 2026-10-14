// emu_b.js with one planted bug: LDB sign-extends
// Daybreak ISA v1 emulator (see SPEC.md). Single ES module, no dependencies.

const MEM_SIZE = 1 << 20;
const LAST_WORD_ADDR = MEM_SIZE - 4;
const FRAME_BYTES = 8192;
const MAX_FRAME_BASE = MEM_SIZE - FRAME_BYTES;
const R_MBZ_MASK = 0x3fff;
const FRAME_MBZ_MASK = 0x3ffff; // rb field and below
const SHIFT_MBZ_MASK = 0x3ffe0; // imm18 bits 17..5

const TRAP_NONE = 0;
const TRAP_ILLEGAL = 1;
const TRAP_MISALIGNED = 2;
const TRAP_BAD_ADDRESS = 3;
const TRAP_NAMES = [null, "ILLEGAL", "MISALIGNED", "BAD_ADDRESS"];

export class Machine {
  constructor(image) {
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
      throw new Error("Daybreak emulator requires a little-endian host");
    }
    if (!(image instanceof Uint8Array)) throw new TypeError("image must be a Uint8Array");
    if (image.length > MEM_SIZE) throw new RangeError("image larger than 1 MiB");
    const buf = new ArrayBuffer(MEM_SIZE);
    this._m8 = new Uint8Array(buf);
    this._m32 = new Uint32Array(buf);
    this._m8.set(image, 0);
    this._r = new Int32Array(16);
    this._pc = 0;
    this._halted = false;
    this._trap = TRAP_NONE;
    this._steps = 0;
    this.onFrame = null;
  }

  get pc() { return this._pc; }
  get halted() { return this._halted; }
  get trap() { return TRAP_NAMES[this._trap]; }
  get steps() { return this._steps; }

  reg(i) {
    if (!Number.isInteger(i) || i < 0 || i > 15) throw new RangeError("register index out of range: " + i);
    return this._r[i] >>> 0;
  }

  readByte(addr) {
    if (!Number.isInteger(addr) || addr < 0 || addr >= MEM_SIZE) throw new RangeError("address out of range: " + addr);
    return this._m8[addr];
  }

  step() {
    this._exec(1);
  }

  run(maxSteps) {
    // No argument means "until halted"; normalizing here keeps the hot loop's single `n < max` check.
    // maxSteps <= 0 (and NaN) fails that check immediately, so nothing executes.
    return this._exec(maxSteps === undefined ? Infinity : maxSteps);
  }

  // Core interpreter loop. State lives in locals; it is written back on exit and
  // after a FRAME completes, just before onFrame is called (so the callback sees
  // pc past the FRAME and steps counting it, and a throw leaves the FRAME done).
  _exec(max) {
    if (this._halted) return 0;
    const R = this._r;
    const M8 = this._m8;
    const M32 = this._m32;
    let pc = this._pc;
    let n = 0;
    let synced = 0;
    let trap = TRAP_NONE;
    let halt = false;

    loop: while (n < max) {
      if (pc & 3) { trap = TRAP_MISALIGNED; n++; break; }
      if (pc > LAST_WORD_ADDR) { trap = TRAP_BAD_ADDRESS; n++; break; }
      const w = M32[pc >>> 2];
      const rd = (w >>> 22) & 15;
      const ra = (w >>> 18) & 15;
      let npc = pc + 4;
      let t = TRAP_NONE;

      switch (w >>> 26) {
        case 0x00:
          if (w !== 0) t = TRAP_ILLEGAL; else { halt = true; npc = pc; }
          break;
        case 0x01:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] + R[(w >>> 14) & 15];
          break;
        case 0x02:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] - R[(w >>> 14) & 15];
          break;
        case 0x03:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] & R[(w >>> 14) & 15];
          break;
        case 0x04:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] | R[(w >>> 14) & 15];
          break;
        case 0x05:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] ^ R[(w >>> 14) & 15];
          break;
        case 0x06:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] << (R[(w >>> 14) & 15] & 31);
          break;
        case 0x07:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] >>> (R[(w >>> 14) & 15] & 31);
          break;
        case 0x08:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] >> (R[(w >>> 14) & 15] & 31);
          break;
        case 0x09:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = Math.imul(R[ra], R[(w >>> 14) & 15]);
          break;
        case 0x0a:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] < R[(w >>> 14) & 15] ? 1 : 0;
          break;
        case 0x0b:
          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = (R[ra] >>> 0) < (R[(w >>> 14) & 15] >>> 0) ? 1 : 0;
          break;
        case 0x10:
          R[rd] = R[ra] + ((w << 14) >> 14);
          break;
        case 0x11:
          R[rd] = R[ra] & (w & 0x3ffff);
          break;
        case 0x12:
          R[rd] = R[ra] | (w & 0x3ffff);
          break;
        case 0x13:
          R[rd] = R[ra] ^ (w & 0x3ffff);
          break;
        case 0x14:
          if (w & SHIFT_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] << (w & 31);
          break;
        case 0x15:
          if (w & SHIFT_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] >>> (w & 31);
          break;
        case 0x16:
          if (w & SHIFT_MBZ_MASK) { t = TRAP_ILLEGAL; break; }
          R[rd] = R[ra] >> (w & 31);
          break;
        case 0x18:
          R[rd] = (w & 0x3fffff) << 10;
          break;
        case 0x20: {
          const addr = (R[ra] + ((w << 14) >> 14)) >>> 0;
          if (addr & 3) t = TRAP_MISALIGNED;
          else if (addr > LAST_WORD_ADDR) t = TRAP_BAD_ADDRESS;
          else R[rd] = M32[addr >>> 2];
          break;
        }
        case 0x21: {
          const addr = (R[ra] + ((w << 14) >> 14)) >>> 0;
          if (addr >= MEM_SIZE) t = TRAP_BAD_ADDRESS;
          else R[rd] = (M8[addr] << 24) >> 24;
          break;
        }
        case 0x22: {
          const addr = (R[ra] + ((w << 14) >> 14)) >>> 0;
          if (addr & 3) t = TRAP_MISALIGNED;
          else if (addr > LAST_WORD_ADDR) t = TRAP_BAD_ADDRESS;
          else M32[addr >>> 2] = R[rd];
          break;
        }
        case 0x23: {
          const addr = (R[ra] + ((w << 14) >> 14)) >>> 0;
          if (addr >= MEM_SIZE) t = TRAP_BAD_ADDRESS;
          else M8[addr] = R[rd];
          break;
        }
        case 0x28:
          if (R[rd] === R[ra]) npc = (pc + 4 + (((w << 14) >> 14) << 2)) >>> 0;
          break;
        case 0x29:
          if (R[rd] !== R[ra]) npc = (pc + 4 + (((w << 14) >> 14) << 2)) >>> 0;
          break;
        case 0x2a:
          if (R[rd] < R[ra]) npc = (pc + 4 + (((w << 14) >> 14) << 2)) >>> 0;
          break;
        case 0x2b:
          if (R[rd] >= R[ra]) npc = (pc + 4 + (((w << 14) >> 14) << 2)) >>> 0;
          break;
        case 0x30:
          R[rd] = pc + 4;
          npc = (pc + 4 + (((w << 10) >> 10) << 2)) >>> 0;
          break;
        case 0x31: {
          const target = (R[ra] + ((w << 14) >> 14)) >>> 0;
          R[rd] = pc + 4;
          npc = target;
          break;
        }
        case 0x38: {
          if (w & FRAME_MBZ_MASK || rd !== 0) { t = TRAP_ILLEGAL; break; }
          const base = R[ra] >>> 0;
          if (base > MAX_FRAME_BASE) { t = TRAP_BAD_ADDRESS; break; }
          const cb = this.onFrame;
          if (cb) {
            // Complete the instruction before calling out: spec section 7 says the callback
            // sees the next pc and a steps count that includes this FRAME, and a throw
            // propagates with the FRAME still done.
            const pixels = M8.slice(base, base + FRAME_BYTES);
            n++;
            pc = npc;
            this._pc = pc;
            this._steps += n - synced;
            synced = n;
            cb(pixels);
            // The callback may have stepped the machine itself; resume from its state.
            pc = this._pc;
            if (this._halted) break loop;
            continue;
          }
          break;
        }
        default:
          t = TRAP_ILLEGAL;
      }

      n++;
      if (t !== TRAP_NONE) { trap = t; break; }
      R[0] = 0;
      pc = npc;
      if (halt) break;
    }

    R[0] = 0;
    this._pc = pc;
    this._steps += n - synced;
    if (trap !== TRAP_NONE) { this._trap = trap; this._halted = true; }
    else if (halt) { this._halted = true; }
    return n;
  }
}
