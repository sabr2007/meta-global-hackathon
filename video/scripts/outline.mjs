// SAM masks (row-major RLE over their own box, starting with a run of 0s; see web/src/ayna/rle.ts)
// to simplified outlines in image pixels: marching squares, closed loops, Douglas-Peucker.

const SIMPLIFY_PX = 1.4;
const MIN_LOOP_PX = 24;

function decode({ w, h, counts }) {
  const raster = new Uint8Array(w * h);
  let position = 0;
  let value = 0;
  for (const count of counts) {
    if (value) raster.fill(1, position, position + count);
    position += count;
    value ^= 1;
  }
  return raster;
}

// Edge midpoints of a cell, in padded-grid units: top, right, bottom, left.
const EDGE = [
  (c, r) => [c + 0.5, r],
  (c, r) => [c + 1, r + 0.5],
  (c, r) => [c + 0.5, r + 1],
  (c, r) => [c, r + 0.5],
];
// Corner code tl*8 + tr*4 + br*2 + bl -> pairs of edges joined inside the cell.
const CASES = {
  1: [[3, 2]],
  2: [[2, 1]],
  3: [[3, 1]],
  4: [[0, 1]],
  5: [[3, 0], [2, 1]],
  6: [[0, 2]],
  7: [[3, 0]],
  8: [[3, 0]],
  9: [[0, 2]],
  10: [[0, 1], [3, 2]],
  11: [[0, 1]],
  12: [[3, 1]],
  13: [[2, 1]],
  14: [[3, 2]],
};

function loops(rle) {
  const { w, h } = rle;
  const raster = decode(rle);
  const W = w + 2;
  const H = h + 2;
  const grid = new Uint8Array(W * H);
  for (let r = 0; r < h; r += 1) for (let c = 0; c < w; c += 1) grid[(r + 1) * W + c + 1] = raster[r * w + c];

  const key = ([x, y]) => `${x},${y}`;
  const links = new Map();
  const link = (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (!links.has(ka)) links.set(ka, { point: a, next: [] });
    if (!links.has(kb)) links.set(kb, { point: b, next: [] });
    links.get(ka).next.push(kb);
    links.get(kb).next.push(ka);
  };
  for (let r = 0; r < H - 1; r += 1) {
    for (let c = 0; c < W - 1; c += 1) {
      const code = grid[r * W + c] * 8 + grid[r * W + c + 1] * 4 + grid[(r + 1) * W + c + 1] * 2 + grid[(r + 1) * W + c];
      for (const [a, b] of CASES[code] ?? []) link(EDGE[a](c, r), EDGE[b](c, r));
    }
  }

  const seen = new Set();
  const result = [];
  for (const [start] of links) {
    if (seen.has(start)) continue;
    const loop = [];
    let previous = null;
    let current = start;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = links.get(current);
      // padded grid -> image pixels (pixel centres at +0.5)
      loop.push([rle.x + node.point[0] - 0.5, rle.y + node.point[1] - 0.5]);
      const next = node.next.find((k) => k !== previous && !seen.has(k));
      previous = current;
      current = next;
    }
    if (loop.length * 0.7 >= MIN_LOOP_PX) result.push(loop);
  }
  return result;
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [x1, y1] = points[first];
    const [x2, y2] = points[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [x, y] = points[i];
      const distance = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / length;
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function closedSimplify(loop) {
  // split the loop at its farthest point from the start so both halves are open polylines
  const [x0, y0] = loop[0];
  let far = 0;
  let best = -1;
  loop.forEach(([x, y], i) => {
    const d = (x - x0) ** 2 + (y - y0) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  });
  const a = simplify(loop.slice(0, far + 1), SIMPLIFY_PX);
  const b = simplify([...loop.slice(far), loop[0]], SIMPLIFY_PX);
  return [...a, ...b.slice(1, -1)];
}

const fmt = (v) => (Math.round(v * 2) / 2).toString();

/** Outline of one mask: an SVG path (image pixels), its centroid and box. */
export function maskOutline(rle) {
  const raster = decode(rle);
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < raster.length; i += 1) {
    if (!raster[i]) continue;
    area += 1;
    sx += i % rle.w;
    sy += Math.floor(i / rle.w);
  }
  const d = loops(rle)
    .map(closedSimplify)
    .filter((loop) => loop.length >= 3)
    .map((loop) => `M${loop.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`)
    .join('');
  return {
    d,
    centroid: area ? [Math.round(rle.x + sx / area + 0.5), Math.round(rle.y + sy / area + 0.5)] : null,
    box: [rle.x, rle.y, rle.w, rle.h],
    areaPx: area,
  };
}
