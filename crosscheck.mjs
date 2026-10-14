// The cross-check as a library: is this emulator equivalent to the reference one on the random
// programs and the interface probes? Stops at the first disagreement, so a wrong candidate
// usually costs a few hundred instructions. Browser-safe.

import { program, state, diff } from "./programs.mjs";
import { PROBES, outcome } from "./probe_set.mjs";

const MAX_STEPS = 4000;

export function crossCheck(A, B, { programs = 300, seed = 11 } = {}) {
  let instructions = 0;
  for (const [name, probe] of Object.entries(PROBES)) {
    const a = JSON.stringify(outcome(() => probe(A))), b = JSON.stringify(outcome(() => probe(B)));
    if (a !== b) return { ok: false, where: `probe "${name}"`, instructions };
  }
  for (let p = 0; p < programs; p++) {
    const image = program(seed * 1000003 + p);
    let a, b;
    try { a = new A(image.slice()); b = new B(image.slice()); } catch (e) { return { ok: false, where: `constructor: ${e.message}`, instructions }; }
    let fa = 0, fb = 0;
    a.onFrame = () => fa++;
    b.onFrame = () => fb++;
    for (let s = 0; s < MAX_STEPS && !(a.halted && b.halted); s++) {
      try { a.step(); b.step(); } catch (e) { return { ok: false, where: `program ${p}, step ${s}: ${e.message}`, instructions }; }
      instructions++;
      const d = diff(state(a), state(b));
      if (d.length || fa !== fb) return { ok: false, where: `program ${p}, instruction ${s + 1}: ${d[0] ?? "frame count"}`, instructions };
    }
  }
  return { ok: true, where: null, instructions };
}
