// Riconoscimento dei marker nell'immagine in scala di grigi.
// Soglia adattiva -> componenti connesse scure -> contorno esterno ->
// quadrilatero -> bordi rifiniti al sub-pixel -> lettura dei bit.

import { GRID, BITS, matchCode } from './dictionary.js';
import { homography, applyH } from './geometry.js';

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export function rgbaToGray(rgba, w, h, out) {
  const g = out && out.length === w * h ? out : new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return g;
}

export class MarkerDetector {
  constructor() {
    this.w = 0;
    this.h = 0;
  }

  alloc(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.integral = new Int32Array((w + 1) * (h + 1));
    this.bin = new Uint8Array(w * h);
    this.labels = new Int32Array(w * h);
    this.stack = new Int32Array(w * h);
  }

  detect(gray, w, h, { minSide = 10, threshC = 7 } = {}) {
    this.alloc(w, h);
    const { integral: I, bin, labels, stack } = this;
    // immagine integrale e soglia adattiva (scuro = 1)
    const W1 = w + 1;
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row;
      }
    }
    const r = Math.max(3, Math.round(Math.min(w, h) * 0.015));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
        const mean = s / ((x1 - x0) * (y1 - y0));
        bin[y * w + x] = gray[y * w + x] < mean - threshC ? 1 : 0;
      }
    }
    // componenti connesse (8-vicinanza) con riempimento a pila
    labels.fill(0);
    const comps = [];
    let next = 1;
    const maxSide = Math.max(w, h) * 0.7;
    for (let p = 0; p < w * h; p++) {
      if (!bin[p] || labels[p]) continue;
      const lab = next++;
      let sp = 0;
      stack[sp++] = p;
      labels[p] = lab;
      let area = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      while (sp) {
        const q = stack[--sp];
        area++;
        const qx = q % w, qy = (q - qx) / w;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
        if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        for (let d = 0; d < 8; d++) {
          const nx = qx + DIRS[d][0], ny = qy + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nq = ny * w + nx;
          if (bin[nq] && !labels[nq]) { labels[nq] = lab; stack[sp++] = nq; }
        }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide) continue;
      if (area < 0.12 * bw * bh || area < 30) continue;
      if (minx === 0 || miny === 0 || maxx === w - 1 || maxy === h - 1) continue;
      comps.push({ lab, start: p, area, bw, bh });
    }
    const found = new Map();
    for (const c of comps) {
      const contour = this.trace(c.start, c.lab, 4 * (c.bw + c.bh) + 16);
      if (!contour || contour.length < 4 * minSide * 0.6) continue;
      const quad = approxQuad(contour);
      if (!quad) continue;
      const refined = refineQuad(gray, w, h, quad) || quad;
      const dec = decode(gray, w, h, refined);
      if (!dec) continue;
      const prev = found.get(dec.id);
      if (!prev || prev.area < c.area) found.set(dec.id, { id: dec.id, corners: dec.corners, dist: dec.dist, area: c.area });
    }
    return [...found.values()];
  }

  // Contorno esterno (Moore) a partire dal pixel più in alto a sinistra.
  trace(start, lab, maxLen) {
    const { w, h, labels } = this;
    const sx = start % w, sy = (start - sx) / w;
    const pts = [[sx, sy]];
    let x = sx, y = sy;
    let dir = 0;
    let firstDir = -1;
    for (let n = 0; n < maxLen; n++) {
      let found = -1;
      for (let k = 0; k < 8; k++) {
        const d = (dir + 5 + k) % 8;
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && labels[ny * w + nx] === lab) { found = d; break; }
      }
      if (found < 0) return null; // pixel isolato
      if (x === sx && y === sy) {
        if (firstDir < 0) firstDir = found;
        else if (found === firstDir) { pts.pop(); return pts; }
      }
      x += DIRS[found][0];
      y += DIRS[found][1];
      dir = found;
      pts.push([x, y]);
    }
    return null;
  }
}

// Approssimazione poligonale (Douglas–Peucker su contorno chiuso) a 4 vertici.
function approxQuad(c) {
  const n = c.length;
  let i1 = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = (c[i][0] - c[0][0]) ** 2 + (c[i][1] - c[0][1]) ** 2;
    if (d > best) { best = d; i1 = i; }
  }
  let i2 = 0; best = -1;
  for (let i = 0; i < n; i++) {
    const d = (c[i][0] - c[i1][0]) ** 2 + (c[i][1] - c[i1][1]) ** 2;
    if (d > best) { best = d; i2 = i; }
  }
  const eps = Math.max(2, 0.03 * n);
  const keep = new Set([i1, i2]);
  const dp = (a, b) => {
    // indici lungo il contorno da a a b (con giro)
    const len = (b - a + n) % n;
    if (len < 2) return;
    const ax = c[a][0], ay = c[a][1];
    const dx = c[b][0] - ax, dy = c[b][1] - ay;
    const L = Math.hypot(dx, dy) || 1;
    let far = -1, fd = -1;
    for (let k = 1; k < len; k++) {
      const i = (a + k) % n;
      const d = Math.abs((c[i][0] - ax) * dy - (c[i][1] - ay) * dx) / L;
      if (d > fd) { fd = d; far = i; }
    }
    if (fd > eps) {
      keep.add(far);
      if (keep.size > 6) return;
      dp(a, far);
      dp(far, b);
    }
  };
  dp(i1, i2);
  dp(i2, i1);
  if (keep.size !== 4) return null;
  const idx = [...keep].sort((a, b) => a - b);
  let q = idx.map((i) => [c[i][0], c[i][1]]);
  // orientamento orario a schermo (area con segno positiva con y in basso)
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) q = q.reverse();
  // convesso e lati non troppo corti
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], d = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (cr <= 0) return null;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 6) return null;
  }
  return q;
}

function bilinear(g, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return -1;
  const x0 = x | 0, y0 = y | 0;
  const fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  const a = g[i] + (g[i + 1] - g[i]) * fx;
  const b = g[i + w] + (g[i + w + 1] - g[i + w]) * fx;
  return a + (b - a) * fy;
}

// Rifinisce i lati cercando lungo la normale il passaggio scuro -> chiaro,
// poi interseca le rette stimate.
function refineQuad(g, w, h, q) {
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const e = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const nrm = [e[1], -e[0]]; // verso l'esterno (lato chiaro)
    const pts = [];
    const samples = Math.max(4, Math.min(16, Math.floor(L / 3)));
    for (let k = 0; k < samples; k++) {
      const tt = 0.18 + (0.64 * k) / (samples - 1);
      const px = a[0] + (b[0] - a[0]) * tt, py = a[1] + (b[1] - a[1]) * tt;
      const prof = [];
      let ok = true;
      for (let j = -6; j <= 6; j++) {
        const v = bilinear(g, w, h, px + nrm[0] * j * 0.5, py + nrm[1] * j * 0.5);
        if (v < 0) { ok = false; break; }
        prof.push(v);
      }
      if (!ok) continue;
      const lo = Math.min(...prof), hi = Math.max(...prof);
      if (hi - lo < 15) continue;
      const mid = (lo + hi) / 2;
      // ultimo attraversamento scuro->chiaro procedendo dall'interno
      let pos = null;
      for (let j = 0; j < prof.length - 1; j++) {
        if (prof[j] < mid && prof[j + 1] >= mid) {
          pos = (j + (mid - prof[j]) / (prof[j + 1] - prof[j])) * 0.5 - 3;
          if (Math.abs(pos) <= 2.5) break;
          pos = null;
        }
      }
      if (pos === null) continue;
      pts.push([px + nrm[0] * pos, py + nrm[1] * pos]);
    }
    if (pts.length < 3) return null;
    lines.push(fitLine(pts));
  }
  const out = [];
  for (let s = 0; s < 4; s++) {
    const p = intersect(lines[(s + 3) % 4], lines[s]);
    if (!p || Math.hypot(p[0] - q[s][0], p[1] - q[s][1]) > 4) return null;
    out.push(p);
  }
  return out;
}

function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] };
}

function intersect(l1, l2) {
  const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const dx = l2.p[0] - l1.p[0], dy = l2.p[1] - l1.p[1];
  const t = (dx * l2.d[1] - dy * l2.d[0]) / den;
  return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t];
}

const CANON = [[0, 0], [GRID, 0], [GRID, GRID], [0, GRID]];

function sampleGrid(g, w, h, H) {
  const vals = new Float32Array(GRID * GRID);
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      let acc = 0, n = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const p = applyH(H, c + 0.3 + sx * 0.2, r + 0.3 + sy * 0.2);
          const v = bilinear(g, w, h, p[0], p[1]);
          if (v >= 0) { acc += v; n++; }
        }
      }
      if (!n) return null;
      vals[r * GRID + c] = acc / n;
    }
  }
  return vals;
}

function decode(g, w, h, quad) {
  let best = null;
  for (let s = 0; s < 4; s++) {
    const corners = [quad[s], quad[(s + 1) % 4], quad[(s + 2) % 4], quad[(s + 3) % 4]];
    const H = homography(CANON, corners);
    if (!H) return null;
    const vals = sampleGrid(g, w, h, H);
    if (!vals) return null;
    let lo = 255, hi = 0;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 25) return null;
    const thr = (lo + hi) / 2;
    let borderErr = 0;
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        if (r === 0 || c === 0 || r === GRID - 1 || c === GRID - 1) if (vals[r * GRID + c] >= thr) borderErr++;
      }
    }
    if (borderErr > 1) return null;
    let code = 0;
    for (let r = 0; r < BITS; r++) {
      for (let c = 0; c < BITS; c++) if (vals[(r + 1) * GRID + c + 1] < thr) code |= 1 << (r * BITS + c);
    }
    const m = matchCode(code);
    if (m && (!best || m.dist < best.dist)) best = { id: m.id, dist: m.dist + borderErr, corners };
  }
  return best;
}
