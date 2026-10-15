# Daybreak

**Nothing trusted. Everything checked.**

Verified computation. One loop under everything: a model (or a search) **proposes**, and an exact
checker — a compiler, a test, a proof, an independent twin — **decides**. The verifier isn't just the
judge; it's also the **teacher** and the **data source**. Only proven outputs survive, and every check
becomes training signal.

**Live:** https://bajpainaman.github.io/daybreak-demo/

## What's in here

| File | What it is |
|---|---|
| `index.html` | The presentation — the idea, the proofs, the honest negatives, what's next. |
| `cpu.html` | **CPU cross-check** — two independently-built emulators of a brand-new ISA run side by side and are compared after every instruction. Doom's fire runs live. |
| `lens.html` | **Daybreak Lens** — an n-gram naturalness view over code. |

## What it shows

- **A CPU born in a day.** Separate agents built two emulators from one spec, never seeing each
  other's code. 71M+ instructions cross-checked, **0 mismatches**; 14/14 planted bugs caught.
- **Bug finding on real code.** Pointed at `reth`, every `fix(` commit is a free, maintainer-labeled
  bug: revert the fix, keep its test, rebuild. ~1 in 4 recent fixes shipped with no regression test.
  No LLM, no fuzzing — and it caught its own false positives.
- **The verifier trains the model.** A from-scratch model learns to synthesize programs by inverting
  the exact interpreter — real MLIR the compiler accepts and runs. Pure reward-only RL collapsed;
  letting the verifier *generate* the data bootstrapped it immediately.
- **The honest part.** Representation wasn't the lever — verification was. We can report what didn't
  work because the verifier makes being wrong cheap.

## Acknowledgments

With thanks to **[Aasim Sani](https://aasimsani.net/)** — the in-network verifier direction builds on
his tool-embedded-LLM research, which showed that a network can learn to feed an exact tool *without
labels* when the read is clean. Daybreak takes that to IR, where the read is always clean.

---

Built in a day · nothing trusted, everything checked.
