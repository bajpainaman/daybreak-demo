// Daybreak ISA v1 assembler and disassembler (SPEC.md sections 2, 3, 8).
// Single ES module, no dependencies; runs in Node 20+ and browsers.

const MEM_SIZE = 1 << 20;
const IMM18_SIGNED = [-131072, 131071];
const IMM18_UNSIGNED = [0, 262143];
const SHIFT_RANGE = [0, 31];
const IMM22_UNSIGNED = [0, 4194303];
const OFF22_SIGNED = [-2097152, 2097151];
const WORD_RANGE = [-2147483648, 4294967295];
const BYTE_RANGE = [-128, 255];

// kind decides operand syntax and encoding; fmt is the spec's format letter.
const INSTRUCTIONS = {
  HALT: { op: 0x00, kind: 'halt' },
  ADD: { op: 0x01, kind: 'r3' },
  SUB: { op: 0x02, kind: 'r3' },
  AND: { op: 0x03, kind: 'r3' },
  OR: { op: 0x04, kind: 'r3' },
  XOR: { op: 0x05, kind: 'r3' },
  SHL: { op: 0x06, kind: 'r3' },
  SHR: { op: 0x07, kind: 'r3' },
  SAR: { op: 0x08, kind: 'r3' },
  MUL: { op: 0x09, kind: 'r3' },
  SLT: { op: 0x0a, kind: 'r3' },
  SLTU: { op: 0x0b, kind: 'r3' },
  ADDI: { op: 0x10, kind: 'iS' },
  ANDI: { op: 0x11, kind: 'iU' },
  ORI: { op: 0x12, kind: 'iU' },
  XORI: { op: 0x13, kind: 'iU' },
  SHLI: { op: 0x14, kind: 'iSh' },
  SHRI: { op: 0x15, kind: 'iSh' },
  SARI: { op: 0x16, kind: 'iSh' },
  LUI: { op: 0x18, kind: 'u' },
  LDW: { op: 0x20, kind: 'mem' },
  LDB: { op: 0x21, kind: 'mem' },
  STW: { op: 0x22, kind: 'mem' },
  STB: { op: 0x23, kind: 'mem' },
  BEQ: { op: 0x28, kind: 'br' },
  BNE: { op: 0x29, kind: 'br' },
  BLT: { op: 0x2a, kind: 'br' },
  BGE: { op: 0x2b, kind: 'br' },
  JAL: { op: 0x30, kind: 'jal' },
  JALR: { op: 0x31, kind: 'jalr' },
  FRAME: { op: 0x38, kind: 'frame' },
};

const PSEUDO_SIZES = { LI: 8, MOV: 4, J: 4, CALL: 4, RET: 4, NOP: 4 };

const BY_OPCODE = new Map(Object.entries(INSTRUCTIONS).map(([m, d]) => [d.op, { mnemonic: m, ...d }]));

const REG_ALIASES = { zero: 0, sp: 15, lr: 14 };
const NAME_RE = /^[A-Za-z_.][A-Za-z0-9_.]*$/;
const LABEL_PREFIX_RE = /^\s*([A-Za-z_.][A-Za-z0-9_.]*)\s*:/;

class AsmError extends Error {}

function fail(msg) {
  throw new AsmError(msg);
}

/** Strip a `;` comment, ignoring `;` inside a char literal. */
function stripComment(line) {
  let inChar = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inChar) {
      if (c === '\\') i++;
      else if (c === "'") inChar = false;
    } else if (c === "'") inChar = true;
    else if (c === ';') return line.slice(0, i);
  }
  return line;
}

/** Split operands on top-level commas (not inside quotes or parentheses). */
function splitOperands(text) {
  const out = [];
  let depth = 0;
  let inChar = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inChar) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) cur += text[++i];
      else if (c === "'") inChar = false;
      continue;
    }
    if (c === "'") inChar = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  for (const o of out) if (o === '') fail('empty operand');
  return out;
}

function parseRegister(text) {
  const t = text.trim().toLowerCase();
  if (t in REG_ALIASES) return REG_ALIASES[t];
  const m = /^r(0|[1-9]\d?)$/.exec(t);
  if (m && Number(m[1]) <= 15) return Number(m[1]);
  return null;
}

function expectRegister(text) {
  const r = parseRegister(text);
  if (r === null) fail(`expected register, got '${text}'`);
  return r;
}

const CHAR_ESCAPES = { n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39, '"': 34 };

function parseIntLiteral(text) {
  const m = /^(-?)(0x[0-9a-f]+|0b[01]+|\d+|'(?:\\.|[^\\'])')$/i.exec(text);
  if (!m) return null;
  const body = m[2];
  let v;
  if (body[0] === "'") {
    if (body[1] === '\\') {
      if (!(body[2] in CHAR_ESCAPES)) fail(`unknown escape in char literal ${body}`);
      v = CHAR_ESCAPES[body[2]];
    } else {
      v = body.codePointAt(1);
      if (v > 255) fail(`char literal ${body} is not a single byte`);
    }
  } else if (/^0x/i.test(body)) v = parseInt(body.slice(2), 16);
  else if (/^0b/i.test(body)) v = parseInt(body.slice(2), 2);
  else v = parseInt(body, 10);
  v = m[1] ? -v : v;
  if (v < WORD_RANGE[0] || v > WORD_RANGE[1]) fail(`integer ${text} does not fit in 32 bits`);
  return v;
}

/**
 * Evaluate a value: integer literal, symbol (.equ or label), or lo()/hi() of one.
 * `lookup(name)` returns a number or throws.
 */
function evalValue(text, lookup) {
  const t = text.trim();
  const fn = /^(lo|hi)\s*\((.*)\)$/i.exec(t);
  if (fn) {
    const x = evalAtom(fn[2].trim(), lookup) >>> 0;
    return fn[1].toLowerCase() === 'hi' ? (x >>> 10) & 0x3fffff : x & 0x3ff;
  }
  return evalAtom(t, lookup);
}

function evalAtom(t, lookup) {
  const lit = parseIntLiteral(t);
  if (lit !== null) return lit;
  if (NAME_RE.test(t)) {
    if (parseRegister(t) !== null) fail(`register '${t}' used where a value is expected`);
    return lookup(t);
  }
  fail(`bad value '${t}'`);
}

function checkRange(v, [lo, hi], what) {
  if (!Number.isInteger(v) || v < lo || v > hi) fail(`${what} ${v} out of range ${lo}..${hi}`);
  return v;
}

/** Parse `imm(ra)` or `(ra)`; returns { immText, ra }. */
function parseMemOperand(text) {
  const m = /^(.*?)\(\s*([^()]+?)\s*\)$/.exec(text.trim());
  if (!m) fail(`expected offset(register), got '${text}'`);
  return { immText: m[1].trim() === '' ? '0' : m[1].trim(), ra: expectRegister(m[2]) };
}

function encR(op, rd, ra, rb) {
  return ((op << 26) | (rd << 22) | (ra << 18) | (rb << 14)) >>> 0;
}
function encI(op, rd, ra, imm) {
  return ((op << 26) | (rd << 22) | (ra << 18) | (imm & 0x3ffff)) >>> 0;
}
function encU(op, rd, imm) {
  return ((op << 26) | (rd << 22) | (imm & 0x3fffff)) >>> 0;
}

function nargs(ops, n, mnemonic) {
  if (ops.length !== n) fail(`${mnemonic} takes ${n} operand${n === 1 ? '' : 's'}, got ${ops.length}`);
}

/** Split a statement into an uppercase mnemonic/directive and the operand text. */
function splitStatement(text) {
  const m = /^(\S+)\s*(.*)$/.exec(text);
  return { name: m[1], rest: m[2].trim() };
}

/**
 * Assemble Daybreak source into a memory image.
 * @param {string} source
 * @returns {{ image: Uint8Array, labels: Record<string, number> }}
 */
export function assemble(source) {
  if (typeof source !== 'string') throw new Error('line 0: source must be a string');
  const lines = source.split(/\r?\n/);
  const labels = Object.create(null);
  const equs = Object.create(null);
  const stmts = []; // { line, name, rest, addr }; .equ lines are fully handled in pass 1

  const defineName = (name, table, value) => {
    if (parseRegister(name) !== null) fail(`'${name}' is a register name`);
    if (name in labels || name in equs) fail(`'${name}' already defined`);
    table[name] = value;
  };
  const pass1Lookup = (name) => {
    if (name in equs) return equs[name];
    if (name in labels) return labels[name];
    fail(`'${name}' must be defined before use here`);
  };
  const pass2Lookup = (name) => {
    if (name in equs) return equs[name];
    if (name in labels) return labels[name];
    fail(`undefined symbol '${name}'`);
  };

  // Pass 1: lay out addresses and define labels / .equ constants.
  let pos = 0;
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    try {
      let text = stripComment(raw);
      let m;
      while ((m = LABEL_PREFIX_RE.exec(text))) {
        defineName(m[1], labels, pos);
        text = text.slice(m[0].length);
      }
      text = text.trim();
      if (text === '') return;
      const { name, rest } = splitStatement(text);
      const upper = name.toUpperCase();
      const stmt = { line: lineNo, name: upper, rest, addr: pos };
      if (upper.startsWith('.')) {
        const ops = rest === '' ? [] : splitOperands(rest);
        switch (upper) {
          case '.ORG': {
            nargs(ops, 1, '.org');
            const target = evalValue(ops[0], pass1Lookup);
            if (target < pos) fail(`.org ${target} moves backward from ${pos}`);
            pos = target;
            break;
          }
          case '.WORD':
            if (ops.length === 0) fail('.word needs at least one value');
            pos += 4 * ops.length;
            break;
          case '.BYTE':
            if (ops.length === 0) fail('.byte needs at least one value');
            pos += ops.length;
            break;
          case '.ZERO': {
            nargs(ops, 1, '.zero');
            const n = evalValue(ops[0], pass1Lookup);
            if (n < 0) fail(`.zero count ${n} is negative`);
            pos += n;
            break;
          }
          case '.ALIGN': {
            nargs(ops, 1, '.align');
            const n = evalValue(ops[0], pass1Lookup);
            if (n <= 0) fail(`.align ${n} must be positive`);
            pos = Math.ceil(pos / n) * n;
            break;
          }
          case '.EQU': {
            nargs(ops, 2, '.equ');
            if (!NAME_RE.test(ops[0])) fail(`bad .equ name '${ops[0]}'`);
            defineName(ops[0], equs, evalValue(ops[1], pass1Lookup));
            return; // emits nothing; no pass-2 work
          }
          default:
            fail(`unknown directive '${name}'`);
        }
      } else {
        const size = upper in INSTRUCTIONS ? 4 : PSEUDO_SIZES[upper];
        if (size === undefined) fail(`unknown mnemonic '${name}'`);
        if (pos % 4 !== 0) fail(`instruction at unaligned address 0x${pos.toString(16)}`);
        pos += size;
      }
      if (pos > MEM_SIZE) fail(`image exceeds memory (${pos} > ${MEM_SIZE} bytes)`);
      stmts.push(stmt);
    } catch (e) {
      if (e instanceof AsmError) throw new Error(`line ${lineNo}: ${e.message}`);
      throw e;
    }
  });

  // Pass 2: encode. Every statement already knows its address.
  const image = new Uint8Array(pos);
  const putWord = (addr, w) => {
    image[addr] = w & 0xff;
    image[addr + 1] = (w >>> 8) & 0xff;
    image[addr + 2] = (w >>> 16) & 0xff;
    image[addr + 3] = (w >>> 24) & 0xff;
  };
  const val = (text) => evalValue(text, pass2Lookup);

  for (const s of stmts) {
    try {
      const ops = s.rest === '' ? [] : splitOperands(s.rest);
      switch (s.name) {
        case '.ORG':
        case '.ZERO':
        case '.ALIGN':
          break; // zero-fill: image is already zeroed
        case '.WORD':
          ops.forEach((o, i) => putWord(s.addr + 4 * i, checkRange(val(o), WORD_RANGE, '.word value') >>> 0));
          break;
        case '.BYTE':
          ops.forEach((o, i) => (image[s.addr + i] = checkRange(val(o), BYTE_RANGE, '.byte value') & 0xff));
          break;
        default:
          encodeInstruction(s, ops, val).forEach((w, i) => putWord(s.addr + 4 * i, w));
      }
    } catch (e) {
      if (e instanceof AsmError) throw new Error(`line ${s.line}: ${e.message}`);
      throw e;
    }
  }

  return { image, labels: { ...labels } };
}

function branchOffset(targetText, addr, val, range, mnemonic) {
  const target = val(targetText);
  if (target % 4 !== 0) fail(`${mnemonic} target 0x${(target >>> 0).toString(16)} is not 4-byte aligned`);
  const off = (target - (addr + 4)) / 4;
  return checkRange(off, range, `${mnemonic} offset`);
}

function encodeInstruction(s, ops, val) {
  const mn = s.name;
  switch (mn) {
    case 'LI': {
      nargs(ops, 2, mn);
      const rd = expectRegister(ops[0]);
      const x = checkRange(val(ops[1]), WORD_RANGE, 'LI value') >>> 0;
      return [encU(0x18, rd, (x >>> 10) & 0x3fffff), encI(0x12, rd, rd, x & 0x3ff)];
    }
    case 'MOV':
      nargs(ops, 2, mn);
      return [encR(0x01, expectRegister(ops[0]), expectRegister(ops[1]), 0)];
    case 'J':
      nargs(ops, 1, mn);
      return [encU(0x30, 0, branchOffset(ops[0], s.addr, val, OFF22_SIGNED, mn))];
    case 'CALL':
      nargs(ops, 1, mn);
      return [encU(0x30, 14, branchOffset(ops[0], s.addr, val, OFF22_SIGNED, mn))];
    case 'RET':
      nargs(ops, 0, mn);
      return [encI(0x31, 0, 14, 0)];
    case 'NOP':
      nargs(ops, 0, mn);
      return [encR(0x01, 0, 0, 0)];
  }
  const { op, kind } = INSTRUCTIONS[mn];
  switch (kind) {
    case 'halt':
      nargs(ops, 0, mn);
      return [0];
    case 'r3':
      nargs(ops, 3, mn);
      return [encR(op, expectRegister(ops[0]), expectRegister(ops[1]), expectRegister(ops[2]))];
    case 'iS':
    case 'iU':
    case 'iSh':
    case 'jalr': {
      nargs(ops, 3, mn);
      const range = kind === 'iU' ? IMM18_UNSIGNED : kind === 'iSh' ? SHIFT_RANGE : IMM18_SIGNED;
      const imm = checkRange(val(ops[2]), range, `${mn} immediate`);
      return [encI(op, expectRegister(ops[0]), expectRegister(ops[1]), imm)];
    }
    case 'u': {
      nargs(ops, 2, mn);
      return [encU(op, expectRegister(ops[0]), checkRange(val(ops[1]), IMM22_UNSIGNED, `${mn} immediate`))];
    }
    case 'mem': {
      nargs(ops, 2, mn);
      const rd = expectRegister(ops[0]);
      const { immText, ra } = parseMemOperand(ops[1]);
      return [encI(op, rd, ra, checkRange(val(immText), IMM18_SIGNED, `${mn} offset`))];
    }
    case 'br': {
      nargs(ops, 3, mn);
      const a = expectRegister(ops[0]);
      const b = expectRegister(ops[1]);
      return [encI(op, a, b, branchOffset(ops[2], s.addr, val, IMM18_SIGNED, mn))];
    }
    case 'jal': {
      nargs(ops, 2, mn);
      const rd = expectRegister(ops[0]);
      return [encU(op, rd, branchOffset(ops[1], s.addr, val, OFF22_SIGNED, mn))];
    }
    case 'frame':
      nargs(ops, 1, mn);
      return [encR(op, 0, expectRegister(ops[0]), 0)];
  }
  throw new Error(`internal: unhandled kind ${kind}`);
}

const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase();
const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);

/**
 * Disassemble one instruction word. Branch/JAL targets are absolute (mod 2^32).
 * Illegal words come back as `.word 0x...` so the output always reassembles.
 * @param {number} word
 * @param {number} address byte address of the word
 * @returns {string}
 */
export function disassemble(word, address = 0) {
  const w = word >>> 0;
  const d = BY_OPCODE.get(w >>> 26);
  const illegal = `.word ${hex(w)}`;
  if (!d) return illegal;
  const rd = (w >>> 22) & 15;
  const ra = (w >>> 18) & 15;
  const rb = (w >>> 14) & 15;
  const imm18 = w & 0x3ffff;
  const imm22 = w & 0x3fffff;
  const low14 = w & 0x3fff;
  const mn = d.mnemonic;
  switch (d.kind) {
    case 'halt':
      return w === 0 ? 'HALT' : illegal;
    case 'r3':
      return low14 ? illegal : `${mn} r${rd}, r${ra}, r${rb}`;
    case 'iS':
    case 'jalr':
      return `${mn} r${rd}, r${ra}, ${sext(imm18, 18)}`;
    case 'iU':
      return `${mn} r${rd}, r${ra}, ${hex(imm18)}`;
    case 'iSh':
      return imm18 & ~31 ? illegal : `${mn} r${rd}, r${ra}, ${imm18}`;
    case 'u':
      return `${mn} r${rd}, ${hex(imm22)}`;
    case 'mem':
      return `${mn} r${rd}, ${sext(imm18, 18)}(r${ra})`;
    case 'br':
      return `${mn} r${rd}, r${ra}, ${hex(address + 4 + sext(imm18, 18) * 4)}`;
    case 'jal':
      return `${mn} r${rd}, ${hex(address + 4 + sext(imm22, 22) * 4)}`;
    case 'frame':
      return rd || rb || low14 ? illegal : `${mn} r${ra}`;
  }
  return illegal;
}
