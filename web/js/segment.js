// Separazione oggetto / sfondo (silhouette) per ogni fotogramma chiave.
//
// - Sopra il bersaglio sappiamo esattamente cosa dovremmo vedere (lo abbiamo
//   stampato noi): ciò che non coincide con il disegno atteso è l'oggetto.
// - Fuori dal bersaglio impariamo i colori dello sfondo dalle zone che
//   l'oggetto non può occupare (fuori dal volume di scansione proiettato).
// Nel dubbio si sceglie "oggetto": un errore in quel verso aggiunge un po'
// di volume che le altre viste toglieranno, l'errore opposto scaverebbe buchi.

import { boardTexture, texCoord, sampleTex } from './board.js';
import { invert3, project, solve } from './geometry.js';

const HBITS = 5;
const HSIZE = 1 << (3 * HBITS);

export class Segmenter {
  constructor(board) {
    this.board = board;
    this.tex = boardTexture(board, { ppm: 2, sigmas: [0.6, 1.2, 2.4] });
  }

  segment(rgba, w, h, K, R, t, vol, opts = {}) {
    const sens = opts.sensitivity ?? 1; // >1 più oggetto, <1 più sfondo
    const tBoard = 0.32 / sens;
    const tDens = 0.6 * sens;
    const n = w * h;
    const { tex, board } = this;
    const mask = new Uint8Array(n);
    const inVol = projectVolumeMask(K, R, t, vol, w, h);
    const H = [
      K.fx * R[0] + K.cx * R[6], K.fx * R[1] + K.cx * R[7], K.fx * t[0] + K.cx * t[2],
      K.fy * R[3] + K.cy * R[6], K.fy * R[4] + K.cy * R[7], K.fy * t[1] + K.cy * t[2],
      R[6], R[7], t[2],
    ];
    const Hi = invert3(H);
    if (!Hi) return null;
    // valore atteso del bersaglio in ogni pixel (-1 = non è bersaglio)
    const tv = new Float32Array(n).fill(-1);
    const kind = new Uint8Array(n);
    const safe2 = board.safeRadius * board.safeRadius;
    const nl = tex.levels.length;
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const c = Hi[6] * u + Hi[7] * v + Hi[8];
        if (c <= 0) continue;
        const X = (Hi[0] * u + Hi[1] * v + Hi[2]) / c;
        const Y = (Hi[3] * u + Hi[4] * v + Hi[5]) / c;
        if (X * X + Y * Y > safe2) continue;
        const du = Math.hypot((Hi[0] - X * Hi[6]) / c, (Hi[3] - Y * Hi[6]) / c);
        const dv = Math.hypot((Hi[1] - X * Hi[7]) / c, (Hi[4] - Y * Hi[7]) / c);
        const fp = Math.max(du, dv);
        let L = 0;
        while (L < nl - 1 && tex.levels[L].sigma < 0.5 * fp) L++;
        const [tx, ty] = texCoord(tex, X, Y);
        const i = v * w + u;
        tv[i] = sampleTex(tex.levels[L].data, tex.size, tx, ty);
        const ki = Math.round(ty) * tex.size + Math.round(tx);
        kind[i] = fp < 1.5 ? tex.kind[ki] : 0;
      }
    }
    // illuminazione: piano bianco (per canale) e nero costante
    const white = fitWhite(rgba, w, h, kind, inVol);
    const black = medianBlack(rgba, w, h, kind, inVol, white);
    if (!white) return { mask: inVol.slice(), w, h, warn: 'bersaglio poco visibile', inVol };

    // istogrammi colore: sfondo (fuori volume) e oggetto (sicuro sul bersaglio)
    const hb = new Float32Array(HSIZE);
    const ho = new Float32Array(HSIZE);
    let nb = 0, no = 0;
    const diff = new Float32Array(n);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const i = v * w + u;
        const j = i * 4;
        const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
        if (tv[i] >= 0) {
          const t0 = tv[i];
          // il canale più diverso: il giallo sul bianco cambia quasi solo il blu
          let d = 0;
          for (let ch = 0; ch < 3; ch++) {
            const W = white[ch][0] + white[ch][1] * u + white[ch][2] * v;
            const E = black[ch] + (W - black[ch]) * t0;
            const dc = Math.abs(rgba[j + ch] - E) / Math.max(W - black[ch], 40);
            if (dc > d) d = dc;
          }
          if (opts.shadows && t0 > 0.6) d = shadowDamp(rgba, j, white, black, u, v, t0, d);
          diff[i] = d;
          if (inVol[i] && d > 0.7) { ho[colorBin(r, g, b)]++; no++; }
        } else if (!inVol[i] && (u & 1) === 0 && (v & 1) === 0) {
          hb[colorBin(r, g, b)]++;
          nb++;
        }
      }
    }
    const hasBg = nb > 150;
    if (hasBg) { blurHist(hb); }
    if (no > 50) blurHist(ho);
    const kb = HSIZE / Math.max(1, nb);
    const ko = HSIZE / Math.max(1, no);
    for (let i = 0; i < n; i++) {
      if (!inVol[i]) continue;
      if (tv[i] >= 0) {
        mask[i] = diff[i] > tBoard ? 1 : 0;
      } else if (!hasBg) {
        mask[i] = 1;
      } else {
        const j = i * 4;
        const bin = colorBin(rgba[j], rgba[j + 1], rgba[j + 2]);
        const db = hb[bin] * kb;
        const dob = no > 50 ? ho[bin] * ko : 0;
        mask[i] = db < tDens || (dob > 4 * db && db < 25 * sens) ? 1 : 0;
      }
    }
    majority(mask, w, h, inVol);
    if (opts.fillHoles !== false) fillHoles(mask, w, h);
    return { mask, w, h, inVol, warn: hasBg ? null : 'sfondo non visibile: allontana il telefono', white, black };
  }
}

function colorBin(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function blurHist(hst) {
  const S = 1 << HBITS;
  const tmp = new Float32Array(hst.length);
  const strides = [1, S, S * S];
  let src = hst, dst = tmp;
  for (const st of strides) {
    for (let i = 0; i < hst.length; i++) {
      const c = Math.floor(i / st) % S;
      let a = src[i];
      if (c > 0) a += src[i - st];
      if (c < S - 1) a += src[i + st];
      dst[i] = a / 3;
    }
    const x = src; src = dst; dst = x;
  }
  if (src !== hst) hst.set(src);
}

// Ombra: stesso colore del foglio, solo più scuro.
function shadowDamp(rgba, j, white, black, u, v, t0, d) {
  let li = 0, le = 0;
  const E = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const W = white[ch][0] + white[ch][1] * u + white[ch][2] * v;
    E[ch] = black[ch] + (W - black[ch]) * t0;
    li += rgba[j + ch];
    le += E[ch];
  }
  if (li < 1 || le < 1) return d;
  const ratio = li / le;
  if (ratio < 0.35 || ratio > 0.97) return d;
  let cd = 0;
  for (let ch = 0; ch < 3; ch++) cd += Math.abs(rgba[j + ch] / li - E[ch] / le);
  return cd < 0.05 ? d * 0.25 : d;
}

function fitWhite(rgba, w, h, kind, inVol) {
  const pts = [];
  for (let v = 0; v < h; v += 2) {
    for (let u = 0; u < w; u += 2) {
      const i = v * w + u;
      if (kind[i] === 1 && !inVol[i]) pts.push(u, v, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }
  }
  if (pts.length / 5 < 30) {
    // ripiego: anche i punti dentro il volume
    for (let v = 0; v < h; v += 2) {
      for (let u = 0; u < w; u += 2) {
        const i = v * w + u;
        if (kind[i] === 1 && inVol[i]) pts.push(u, v, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
      }
    }
  }
  const m = pts.length / 5;
  if (m < 20) return null;
  let use = new Uint8Array(m).fill(1);
  let model = null;
  for (let iter = 0; iter < 3; iter++) {
    model = [0, 1, 2].map((ch) => fitPlane(pts, use, ch, w, h));
    if (model.some((x) => !x)) return null;
    const res = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      let e = 0;
      for (let ch = 0; ch < 3; ch++) {
        const p = model[ch];
        e += Math.abs(pts[k * 5 + 2 + ch] - (p[0] + p[1] * pts[k * 5] + p[2] * pts[k * 5 + 1]));
      }
      res[k] = e;
    }
    const med = Float32Array.from(res).sort()[m >> 1];
    const lim = 2.5 * med + 12;
    const next = new Uint8Array(m);
    let cnt = 0;
    for (let k = 0; k < m; k++) if (res[k] <= lim) { next[k] = 1; cnt++; }
    if (cnt < 15) break;
    use = next;
  }
  return model;
}

function fitPlane(pts, use, ch, w, h) {
  // coordinate normalizzate per un sistema ben condizionato
  const A = new Float64Array(9);
  const b = new Float64Array(3);
  const sx = 2 / w, sy = 2 / h;
  for (let k = 0; k < use.length; k++) {
    if (!use[k]) continue;
    const x = pts[k * 5] * sx - 1, y = pts[k * 5 + 1] * sy - 1, z = pts[k * 5 + 2 + ch];
    const row = [1, x, y];
    for (let a = 0; a < 3; a++) {
      b[a] += row[a] * z;
      for (let c = 0; c < 3; c++) A[a * 3 + c] += row[a] * row[c];
    }
  }
  for (let a = 0; a < 3; a++) A[a * 4] += 1e-6;
  const p = solve(A, b, 3);
  if (!p) return null;
  // ritorna coefficienti in pixel: W = p0 + p1*u + p2*v
  return [p[0] - p[1] - p[2], p[1] * sx, p[2] * sy];
}

function medianBlack(rgba, w, h, kind, inVol, white) {
  const vals = [[], [], []];
  for (let v = 0; v < h; v += 1) {
    for (let u = 0; u < w; u += 1) {
      const i = v * w + u;
      if (kind[i] === 2 && !inVol[i]) for (let ch = 0; ch < 3; ch++) vals[ch].push(rgba[i * 4 + ch]);
    }
  }
  return [0, 1, 2].map((ch) => {
    const a = vals[ch];
    if (a.length < 10) return white ? Math.max(0, 0.15 * (white[ch][0] + white[ch][1] * w / 2 + white[ch][2] * h / 2)) : 30;
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  });
}

// Maschera dei pixel in cui può cadere il volume di scansione (cilindro).
export function projectVolumeMask(K, R, t, vol, w, h) {
  const m = new Uint8Array(w * h);
  const pts = [];
  const N = 32;
  for (const z of [0, vol.height]) {
    for (let k = 0; k < N; k++) {
      const a = (2 * Math.PI * k) / N;
      const p = project(K, R, t, [vol.radius * Math.cos(a) * 1.04, vol.radius * Math.sin(a) * 1.04, z]);
      if (p[2] <= 1) { m.fill(1); return m; }
      pts.push(p);
    }
  }
  const hull = convexHull(pts);
  // allarga di qualche pixel attorno al baricentro
  let mx = 0, my = 0;
  for (const p of hull) { mx += p[0]; my += p[1]; }
  mx /= hull.length; my /= hull.length;
  const poly = hull.map((p) => {
    const dx = p[0] - mx, dy = p[1] - my, L = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / L) * 3, p[1] + (dy / L) * 3];
  });
  fillPolygon(m, w, h, poly);
  return m;
}

export function convexHull(pts) {
  const p = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossZ = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

export function fillPolygon(m, w, h, poly) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of poly) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const y0 = Math.max(0, Math.ceil(ymin)), y1 = Math.min(h - 1, Math.floor(ymax));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k])), xb = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) m[y * w + x] = 1;
    }
  }
}

function majority(mask, w, h, inVol) {
  const src = mask.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inVol[i]) continue;
      const s = src[i - w - 1] + src[i - w] + src[i - w + 1] + src[i - 1] + src[i] + src[i + 1] + src[i + w - 1] + src[i + w] + src[i + w + 1];
      mask[i] = s >= 5 ? 1 : 0;
    }
  }
}

// Riempie i buchi chiusi della silhouette (sfondo non collegato al bordo).
export function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!mask[i] && !seen[i]) mask[i] = 1;
}

// Distanza con segno dal contorno della silhouette, in pixel (positiva dentro).
// Distanza euclidea esatta (Felzenszwalb–Huttenlocher): niente direzioni privilegiate,
// che sul solido diventerebbero rigature.
export function signedDistance(mask, w, h, maxD = 24) {
  const din = edt(mask, w, h, 0); // dentro: distanza dal pixel di sfondo più vicino
  const dout = edt(mask, w, h, 1); // fuori: distanza dal pixel di oggetto più vicino
  const sd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = mask[i] ? Math.sqrt(din[i]) - 0.5 : 0.5 - Math.sqrt(dout[i]);
    sd[i] = d > maxD ? maxD : d < -maxD ? -maxD : d;
  }
  return sd;
}

const BIG = 1e12;

// Distanza euclidea al quadrato dal pixel più vicino con mask == site.
function edt(mask, w, h, site) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const out = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] === site ? 0 : BIG;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
