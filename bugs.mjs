// Realistic one-line bugs for emulator B, each [name, original text, replacement]. mutants.mjs
// measures how many the checks catch; build.mjs turns each into a module the demo page can swap
// in live.

export const BUGS = [
  ["SLT compares unsigned", "R[rd] = R[ra] < R[(w >>> 14) & 15] ? 1 : 0;", "R[rd] = (R[ra] >>> 0) < (R[(w >>> 14) & 15] >>> 0) ? 1 : 0;"],
  ["ADDI zero-extends its immediate", "R[rd] = R[ra] + ((w << 14) >> 14);", "R[rd] = R[ra] + (w & 0x3ffff);"],
  ["ORI sign-extends its immediate", "R[rd] = R[ra] | (w & 0x3ffff);", "R[rd] = R[ra] | ((w << 14) >> 14);"],
  ["LUI shifts by 12, not 10", "R[rd] = (w & 0x3fffff) << 10;", "R[rd] = (w & 0x3fffff) << 12;"],
  ["BNE offset counted from pc, not next", "if (R[rd] !== R[ra]) npc = (pc + 4 + (((w << 14) >> 14) << 2)) >>> 0;", "if (R[rd] !== R[ra]) npc = (pc + (((w << 14) >> 14) << 2)) >>> 0;"],
  ["BGE tests >, not >=", "if (R[rd] >= R[ra]) npc", "if (R[rd] > R[ra]) npc"],
  ["LDB sign-extends", "else R[rd] = M8[addr];", "else R[rd] = (M8[addr] << 24) >> 24;"],
  ["LDW checks bounds before alignment",
    "if (addr & 3) t = TRAP_MISALIGNED;\n          else if (addr > LAST_WORD_ADDR) t = TRAP_BAD_ADDRESS;\n          else R[rd] = M32[addr >>> 2];",
    "if (addr > LAST_WORD_ADDR) t = TRAP_BAD_ADDRESS;\n          else if (addr & 3) t = TRAP_MISALIGNED;\n          else R[rd] = M32[addr >>> 2];"],
  ["JALR writes rd before reading ra",
    "const target = (R[ra] + ((w << 14) >> 14)) >>> 0;\n          R[rd] = pc + 4;",
    "R[rd] = pc + 4;\n          const target = (R[ra] + ((w << 14) >> 14)) >>> 0;"],
  ["FRAME's last legal base is off by one", "if (base > MAX_FRAME_BASE)", "if (base >= MAX_FRAME_BASE)"],
  ["HALT advances pc", "else { halt = true; npc = pc; }", "else { halt = true; }"],
  ["MUL through a float multiply", "R[rd] = Math.imul(R[ra], R[(w >>> 14) & 15]);", "R[rd] = (R[ra] * R[(w >>> 14) & 15]) | 0;"],
  ["SUB ignores its must-be-zero bits", "case 0x02:\n          if (w & R_MBZ_MASK) { t = TRAP_ILLEGAL; break; }\n", "case 0x02:\n"],
  ["SARI shifts in zeros", "R[rd] = R[ra] >> (w & 31);", "R[rd] = R[ra] >>> (w & 31);"],
];

export function applyBug(source, [name, from, to]) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`bug "${name}": expected the original text once in emu_b.js, found it ${count} times`);
  return source.replace(from, to);
}
