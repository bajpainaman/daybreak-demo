// Plain-JavaScript reference for the Daybreak Doom fire benchmark (SPEC.md section 9).
// No Daybreak involved: this is the algorithm transcribed directly, used to check
// emulator/assembly output byte for byte.

const W = 128;
const H = 64;
const MAX = 36;
const SEED0 = 0x2f6b1a93;

/**
 * Render n frames of the fire effect.
 * @param {number} n number of frames
 * @returns {Uint8Array[]} n independent copies of the 8192-byte buffer, one per frame
 */
export function fireFrames(n) {
  const fire = new Uint8Array(W * H);
  fire.fill(MAX, (H - 1) * W);
  let seed = SEED0 >>> 0;

  const rand = () => {
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    return seed;
  };

  const frames = [];
  for (let f = 0; f < n; f++) {
    for (let x = 0; x < W; x++) {
      for (let y = 1; y < H; y++) {
        const src = y * W + x;
        const p = fire[src];
        if (p === 0) {
          fire[src - W] = 0;
        } else {
          const r = rand() & 3;
          const dst = src - r + 1 - W; // ordinary JS number: signed, can be negative
          if (dst >= 0 && dst < W * H) fire[dst] = p - (r & 1);
        }
      }
    }
    frames.push(fire.slice());
  }
  return frames;
}
