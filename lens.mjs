// Daybreak Lens: how surprising is each token of a program to a model trained only on the
// codebase it lives in? No LLM: an interpolated n-gram model, trained by counting, in seconds.
//
// A token the model finds unlikely, where some other token would make the surrounding window
// much more likely, is a candidate bug, and that other token is the candidate fix: a lookup in
// the counts. Buggy lines are measurably less "natural" than the code around them (Ray et al.,
// "On the 'Naturalness' of Buggy Code", ICSE 2016).
//
// The model is trained on the code as uploaded, bugs included. Each position is judged
// leave-one-out: the counts it contributed are removed before it is scored, so a line never
// vouches for itself and a one-off deviation is outvoted by the habit everywhere else.
//
// Runs unchanged in Node and in the browser.

const ORDER = 4;          // tokens of left context, plus one
const DISCOUNT = 0.75;    // absolute discounting, as in Kneser-Ney
const RIGHT = 3;          // tokens after a position that also vote on what belongs there
const CANDIDATES = 40;    // alternatives considered per position
const ALTERNATIVES = 5;   // of which the best few are kept as repair candidates
const DECLARES = new Set(["const", "let", "var", "function", "class", "fn", "def", "struct", "enum", "type", "trait",
  "interface", "impl", "mod", "package", "import", "export", "func", "val", "static"]);

// Strings may span lines (a Rust string continued with a backslash). A Rust lifetime, 'a, is
// a token of its own rather than the start of a quoted string.
const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'[A-Za-z_]\w*(?![\w'])|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`|0[xXbB][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|>>>=|>>>|<<=|>>=|===|!==|\*\*|=>|->|::|&&|\|\||\+\+|--|[<>=!+\-*\/%&|^]=|<<|>>|\S/g;

// Tokens with their offsets. Comments are kept for display but not modelled.
export function tokenize(source) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(source)) !== null) {
    const t = m[0];
    out.push({ text: t, start: m.index, end: m.index + t.length, model: !(t.startsWith("//") || t.startsWith("/*")) });
  }
  return out;
}

const key = (toks, from, to) => toks.slice(from, to).join("\u0001");

export class Lens {
  constructor() {
    // counts[k]: Map(context of k tokens -> row); a row is Map(token -> count) plus `total`.
    this.counts = Array.from({ length: ORDER }, () => new Map());
    this.files = 0;
    this.tokens = 0;
    this.sources = new Map();  // name -> modelled tokens, for leave-one-out scoring
  }

  _bump(toks, p, delta) {
    for (let k = 0; k < ORDER && p - k >= 0; k++) {
      const ck = key(toks, p - k, p);
      let row = this.counts[k].get(ck);
      if (!row) { row = new Map(); row.total = 0; this.counts[k].set(ck, row); }
      const c = (row.get(toks[p]) ?? 0) + delta;
      if (c > 0) row.set(toks[p], c); else row.delete(toks[p]);
      row.total += delta;
    }
  }

  // Training is counting every token after every context of 0..ORDER-1 tokens.
  train(source, name = `file${this.files}`) {
    const toks = tokenize(source).filter((t) => t.model).map((t) => t.text);
    for (let p = 0; p < toks.length; p++) this._bump(toks, p, +1);
    this.sources.set(name, toks);
    this.files++;
    this.tokens += toks.length;
  }

  get vocab() { return this.counts[0].get("")?.size ?? 0; }

  // P(w | context), interpolating down to a smoothed unigram.
  prob(ctx, w) {
    const uni = this.counts[0].get("");
    let p = ((uni?.get(w) ?? 0) + 0.5) / ((uni?.total ?? 0) + 0.5 * ((uni?.size ?? 0) + 1));
    for (let k = 1; k < ORDER && k <= ctx.length; k++) {
      const row = this.counts[k].get(key(ctx, ctx.length - k, ctx.length));
      if (!row || row.total <= 0) break;
      p = (Math.max((row.get(w) ?? 0) - DISCOUNT, 0) + DISCOUNT * row.size * p) / row.total;
    }
    return p;
  }

  candidates(ctx) {
    for (let k = Math.min(ORDER - 1, ctx.length); k >= 0; k--) {
      const row = this.counts[k].get(key(ctx, ctx.length - k, ctx.length));
      if (row && row.size) return [...row.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([w]) => w);
    }
    return [];
  }

  // log2 P of the window around i with w at i: w given its left context, then RIGHT tokens after.
  _window(toks, i, w) {
    const ctx = toks.slice(Math.max(0, i - ORDER + 1), i);
    let lp = Math.log2(this.prob(ctx, w));
    for (let j = 1; j <= RIGHT && i + j < toks.length; j++) {
      const c = toks.slice(Math.max(0, i + j - ORDER + 1), i + j);
      c[c.length - j] = w;
      lp += Math.log2(this.prob(c, toks[i + j]));
    }
    return lp;
  }

  // Score every modelled token of a source. If the source was trained under `name`, each
  // position is scored leave-one-out. Each token gets: prob and bits (its surprise), top (the
  // model's five best guesses there), fix (the token that makes its window most likely) and
  // gain (how many bits more likely the window is with the fix).
  score(source, name = null) {
    const all = tokenize(source);
    const pos = [];
    all.forEach((t, j) => { if (t.model) pos.push(j); });
    const toks = pos.map((j) => all[j].text);
    const trained = name !== null && this.sources.has(name);
    if (trained && this.sources.get(name).join("\u0001") !== toks.join("\u0001")) {
      throw new Error(`score: ${name} changed since it was trained; train the new text first`);
    }
    for (let i = 0; i < toks.length; i++) {
      const hi = Math.min(toks.length - 1, i + RIGHT);
      if (trained) for (let p = i; p <= hi; p++) this._bump(toks, p, -1);
      const t = all[pos[i]];
      const ctx = toks.slice(Math.max(0, i - ORDER + 1), i);
      t.prob = this.prob(ctx, toks[i]);
      t.bits = -Math.log2(t.prob);
      const cands = this.candidates(ctx);
      t.top = cands.map((w) => [w, this.prob(ctx, w)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const here = this._window(toks, i, toks[i]);
      // Every alternative that makes the window more likely, best first: the repair candidates.
      // Not for text in quotes (editing a message is never the fix) or a name being declared
      // (every declared name is unique, so every one would look surprising).
      const fixed = /^["'`]/.test(toks[i]) || DECLARES.has(toks[i - 1]);
      t.alts = fixed ? [] : cands.filter((w) => w !== toks[i]).map((w) => [w, this._window(toks, i, w) - here])
        .filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1]).slice(0, ALTERNATIVES);
      t.fix = t.alts[0]?.[0] ?? null;
      t.gain = t.alts[0]?.[1] ?? 0;
      if (trained) for (let p = i; p <= hi; p++) this._bump(toks, p, +1);
    }
    return all;
  }

  // Lines ranked by their most suspicious token.
  lines(source, scored) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    const rows = new Map();
    let line = 1;
    for (const t of scored) {
      if (!t.model) continue;
      while (line < starts.length && starts[line] <= t.start) line++;
      const r = rows.get(line) ?? { line, gain: 0, bits: 0, tokens: 0, token: null };
      r.tokens++;
      r.bits += t.bits;
      if (t.gain > r.gain) { r.gain = t.gain; r.token = t; }
      rows.set(line, r);
    }
    return [...rows.values()].sort((a, b) => b.gain - a.gain);
  }
}
