'use strict';

/**
 * Marching-squares contour extraction.
 * Returns polylines in grid coordinates. Handles saddle cells via the cell centre.
 */
function extractContours(z, width, height, levels, options = {}) {
  const results = new Map();
  const eps = options.epsilon ?? 0.38;
  for (const level of levels) results.set(level, []);

  const segmentsByLevel = new Map();
  for (const level of levels) segmentsByLevel.set(level, []);

  for (let y = 0; y < height - 1; y++) {
    const row = y * width;
    const next = row + width;
    for (let x = 0; x < width - 1; x++) {
      const a = z[row + x];
      const b = z[row + x + 1];
      const c = z[next + x + 1];
      const d = z[next + x];
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      for (const level of levels) {
        if (level < lo || level > hi) continue;
        const mask = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
        if (mask === 0 || mask === 15) continue;
        const segs = segmentsByLevel.get(level);
        const centerHigh = ((a + b + c + d) / 4) >= level;
        addCellSegments(segs, mask, centerHigh, level, x, y, a, b, c, d);
      }
    }
  }

  for (const level of levels) {
    const joined = joinSegments(segmentsByLevel.get(level));
    const cleaned = [];
    for (const line of joined) {
      if (line.length < 3) continue;
      const closed = Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < 1e-5;
      let simplified = simplifyRdp(line, eps);
      if (options.chaikin !== 0) simplified = chaikin(simplified, options.chaikin ?? 2, closed);
      simplified = smoothPoints(simplified, options.smoothPasses ?? 3, closed);
      simplified = simplifyRdp(simplified, eps * 0.28);
      if (simplified.length >= 2) cleaned.push(simplified);
    }
    cleaned.sort((p, q) => polylineLength(q) - polylineLength(p));
    results.set(level, cleaned);
  }
  return results;
}

function addCellSegments(out, mask, centerHigh, level, x, y, a, b, c, d) {
  const T = () => interp(x, y, a, x + 1, y, b, level);
  const R = () => interp(x + 1, y, b, x + 1, y + 1, c, level);
  const B = () => interp(x, y + 1, d, x + 1, y + 1, c, level);
  const L = () => interp(x, y, a, x, y + 1, d, level);
  const push = (p, q) => { if (p && q) out.push([p, q]); };
  switch (mask) {
    case 1: push(L(), T()); break;
    case 2: push(T(), R()); break;
    case 3: push(L(), R()); break;
    case 4: push(R(), B()); break;
    case 5:
      if (centerHigh) { push(T(), R()); push(B(), L()); }
      else { push(L(), T()); push(R(), B()); }
      break;
    case 6: push(T(), B()); break;
    case 7: push(L(), B()); break;
    case 8: push(B(), L()); break;
    case 9: push(T(), B()); break;
    case 10:
      if (centerHigh) { push(L(), T()); push(R(), B()); }
      else { push(T(), R()); push(B(), L()); }
      break;
    case 11: push(R(), B()); break;
    case 12: push(L(), R()); break;
    case 13: push(T(), R()); break;
    case 14: push(L(), T()); break;
    default: break;
  }
}

function interp(x0, y0, v0, x1, y1, v1, level) {
  const denom = v1 - v0;
  const t = denom === 0 ? 0.5 : (level - v0) / denom;
  const tc = Math.max(0, Math.min(1, t));
  return [x0 + (x1 - x0) * tc, y0 + (y1 - y0) * tc];
}

function keyOf(p) {
  return `${Math.round(p[0] * 10000)},${Math.round(p[1] * 10000)}`;
}

function joinSegments(segments) {
  if (!segments.length) return [];
  const adjacency = new Map();
  const edges = segments.map(([p0, p1], index) => {
    const k0 = keyOf(p0), k1 = keyOf(p1);
    for (const [k, p] of [[k0, p0], [k1, p1]]) {
      if (!adjacency.has(k)) adjacency.set(k, []);
      adjacency.get(k).push({ index, other: p, key: k === k0 ? k1 : k0 });
    }
    return { p0, p1, k0, k1, used: false };
  });
  const lines = [];
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].used) continue;
    const e = edges[i];
    e.used = true;
    const path = [e.p0, e.p1];
    // forward
    let current = e.p1, currentKey = e.k1;
    let closed = false;
    while (true) {
      const candidates = adjacency.get(currentKey) || [];
      const next = candidates.find(c => !edges[c.index].used);
      if (!next) break;
      const edge = edges[next.index];
      edge.used = true;
      const other = edge.k0 === currentKey ? edge.p1 : edge.p0;
      const otherKey = edge.k0 === currentKey ? edge.k1 : edge.k0;
      if (otherKey === keyOf(path[0])) { path.push(other); closed = true; break; }
      path.push(other);
      current = other; currentKey = otherKey;
    }
    if (!closed) {
      current = e.p0; currentKey = e.k0;
      while (true) {
        const candidates = adjacency.get(currentKey) || [];
        const next = candidates.find(c => !edges[c.index].used);
        if (!next) break;
        const edge = edges[next.index];
        edge.used = true;
        const other = edge.k0 === currentKey ? edge.p1 : edge.p0;
        const otherKey = edge.k0 === currentKey ? edge.k1 : edge.k0;
        path.unshift(other);
        current = other; currentKey = otherKey;
      }
    }
    if (path.length >= 2) lines.push(path);
  }
  return lines;
}

function distanceSq(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function simplifyRdp(points, epsilon) {
  if (points.length < 3) return points;
  const sq = epsilon * epsilon;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0, index = -1;
    const a = points[first], b = points[last];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      let t = lenSq ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const d = distanceSq(p, [a[0] + t * dx, a[1] + t * dy]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > sq && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function chaikin(points, passes = 1, closed = false) {
  let pts = points;
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) return pts;
    const out = [];
    if (!closed) out.push(pts[0]);
    const n = pts.length;
    const limit = closed ? n : n - 1;
    for (let i = 0; i < limit; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    if (!closed) out.push(pts[n - 1]); else out.push(out[0]);
    pts = out;
  }
  return pts;
}

function smoothPoints(points, passes = 1, closed = false) {
  let pts = points;
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 4) return pts;
    const n = pts.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
      const cur = pts[i];
      const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
      out[i] = [prev[0] * 0.25 + cur[0] * 0.5 + next[0] * 0.25, prev[1] * 0.25 + cur[1] * 0.5 + next[1] * 0.25];
    }
    pts = out;
  }
  return pts;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

module.exports = { extractContours, polylineLength, simplifyRdp, chaikin, smoothPoints };
