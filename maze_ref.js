// Daybreak maze benchmark: plain JavaScript reference (SPEC.md section 10).
// Single ES module, no dependencies; runs in Node 20+ and browsers.

const W = 128;
const H = 64;
const CELLS = W * H;

/** Address in the program image where the bytes from layout() go. */
export const LAYOUT_ADDR = 0x20000;
/** Output words the program writes before HALT. */
export const PATH_LENGTH_ADDR = 0x22010;
export const REACHED_ADDR = 0x22014;
/** pathLength when the goal is unreachable. */
export const UNREACHABLE = 0xffffffff;

const PARAMS_OFFSET = 0x2000; // start x, start y, goal x, goal y, relative to LAYOUT_ADDR
const PARAM_WORDS = 4;
const LAYOUT_SIZE = PARAMS_OFFSET + 4 * PARAM_WORDS;

// frame(d) cell values (section 10 table)
const UNREACHED = 0;
const WALL = 1;
const NEWEST = 2;
const LAYER_BASE = 3; // older layers are LAYER_BASE + (dist & LAYER_MASK), 3..34
const LAYER_MASK = 31;
const PATH = 35;
const ENDPOINT = 36;

function cellIndex(x, y, what) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= W || y < 0 || y >= H) {
    throw new RangeError(`${what} (${x}, ${y}) is outside the ${W}x${H} grid`);
  }
  return y * W + x;
}

/** Enforce the host guarantees of section 10 instead of inventing behaviour for bad input. */
function checkInputs(maze, sx, sy, gx, gy) {
  if (!(maze instanceof Uint8Array) || maze.length !== CELLS) {
    throw new TypeError(`maze must be a Uint8Array of ${CELLS} bytes`);
  }
  const start = cellIndex(sx, sy, 'start');
  const goal = cellIndex(gx, gy, 'goal');
  if (maze[start] !== 0) throw new RangeError(`start (${sx}, ${sy}) is a wall`);
  if (maze[goal] !== 0) throw new RangeError(`goal (${gx}, ${gy}) is a wall`);
  return { start, goal };
}

/**
 * Run the section 10 breadth-first search and return every frame the program must emit.
 * @param {Uint8Array} maze 8,192 bytes, row-major; 0 = open, any other value = wall
 * @param {number} sx start x (0..127)
 * @param {number} sy start y (0..63)
 * @param {number} gx goal x (0..127)
 * @param {number} gy goal y (0..63)
 * @returns {{ frames: Uint8Array[], pathLength: number, reached: number }} frames in emission
 *   order (8,192 bytes each, final frame last); pathLength is UNREACHABLE when the goal is not found
 */
export function mazeFrames(maze, sx, sy, gx, gy) {
  const { start, goal } = checkInputs(maze, sx, sy, gx, gy);
  const dist = new Int32Array(CELLS).fill(-1);
  const parent = new Int32Array(CELLS).fill(-1);
  dist[start] = 0;
  let frontier = [start];
  let next = [];
  let d = 0;
  let found = start === goal;

  const discover = (n, c) => {
    if (maze[n] === 0 && dist[n] === -1) {
      dist[n] = d + 1;
      parent[n] = c;
      next.push(n);
      if (n === goal) found = true;
    }
  };

  // `frame` always holds frame(d) for the current d. frame(d) differs from frame(d-1) only in
  // layer d-1 (no longer newest) and layer d (newly reached), so each layer patches those cells
  // instead of rescanning the grid: long mazes emit thousands of frames.
  // frame(0): walls 1, everything else unreached except start (dist 0 == d), which is pinned to 36.
  const frame = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) frame[i] = maze[i] !== 0 ? WALL : UNREACHED;
  frame[start] = ENDPOINT;
  frame[goal] = ENDPOINT;

  const frames = [];
  while (frontier.length > 0 && !found) {
    next = [];
    for (const c of frontier) {
      const x = c % W;
      const y = (c - x) / W;
      if (y > 0) discover(c - W, c); // up
      if (x < W - 1) discover(c + 1, c); // right
      if (y < H - 1) discover(c + W, c); // down
      if (x > 0) discover(c - 1, c); // left
    }
    d += 1;
    for (const c of frontier) frame[c] = LAYER_BASE + ((d - 1) & LAYER_MASK);
    for (const n of next) frame[n] = NEWEST;
    frame[start] = ENDPOINT;
    frame[goal] = ENDPOINT;
    frames.push(frame.slice());
    frontier = next;
  }

  // Final frame: the last frame(d) again (frame(0) when the loop never ran), with the path drawn.
  const final = frame.slice();
  if (found) {
    for (let c = goal; ; c = parent[c]) {
      final[c] = PATH;
      if (c === start) break;
    }
    final[start] = ENDPOINT;
    final[goal] = ENDPOINT;
  }
  frames.push(final);

  let reached = 0;
  for (let i = 0; i < CELLS; i++) if (dist[i] !== -1) reached++;
  return { frames, pathLength: found ? dist[goal] : UNREACHABLE, reached };
}

/**
 * The bytes a host puts into a program image at LAYOUT_ADDR (0x20000 up to, not including,
 * 0x22010): the maze, then start x, start y, goal x, goal y as little-endian words.
 * @param {Uint8Array} maze 8,192 bytes, row-major; 0 = open, any other value = wall
 * @param {number} sx
 * @param {number} sy
 * @param {number} gx
 * @param {number} gy
 * @returns {Uint8Array} 0x2010 bytes
 */
export function layout(maze, sx, sy, gx, gy) {
  checkInputs(maze, sx, sy, gx, gy);
  const out = new Uint8Array(LAYOUT_SIZE);
  out.set(maze, 0);
  const view = new DataView(out.buffer);
  [sx, sy, gx, gy].forEach((v, k) => view.setUint32(PARAMS_OFFSET + 4 * k, v, true));
  return out;
}
