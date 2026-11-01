// Geometria: omografie, posa della fotocamera, stima della focale.
// Matrici 3x3 come array piatti riga per riga. Convenzione fotocamera OpenCV:
// x a destra, y in basso, z in avanti. Posa: Xcam = R * Xboard + t.
// K = { fx, fy, cx, cy } con il centro del pixel (0,0) alle coordinate (0,0).

export function mat3mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

export function mat3vec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function det3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

export function invert3(m) {
  const d = det3(m);
  if (!d) return null;
  const i = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * i, (m[2] * m[7] - m[1] * m[8]) * i, (m[1] * m[5] - m[2] * m[4]) * i,
    (m[5] * m[6] - m[3] * m[8]) * i, (m[0] * m[8] - m[2] * m[6]) * i, (m[2] * m[3] - m[0] * m[5]) * i,
    (m[3] * m[7] - m[4] * m[6]) * i, (m[1] * m[6] - m[0] * m[7]) * i, (m[0] * m[4] - m[1] * m[3]) * i,
  ];
}

export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// Autovalori/autovettori di una matrice simmetrica n x n (Jacobi ciclico).
// Restituisce valori crescenti e vettori come colonne (array di array).
export function eigenSym(A, n) {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [...Array(n).keys()].sort((i, j) => a[i * n + i] - a[j * n + j]);
  return {
    values: idx.map((i) => a[i * n + i]),
    vectors: idx.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i])),
  };
}

// Risolve A x = b (n x n) con eliminazione di Gauss e pivot parziale.
export function solve(A, b, n) {
  const m = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[p * n + c])) p = r;
    if (Math.abs(m[p * n + c]) < 1e-15) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = m[c * n + k]; m[c * n + k] = m[p * n + k]; m[p * n + k] = t; }
      const t = x[c]; x[c] = x[p]; x[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = m[r * n + c] / m[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) m[r * n + k] -= f * m[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= m[r * n + k] * x[k];
    x[r] = s / m[r * n + r];
  }
  return Array.from(x);
}

function normalization(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

// Omografia (DLT normalizzata) che porta src[i] in dst[i]. Almeno 4 punti.
export function homography(src, dst) {
  const n = src.length;
  if (n < 4) return null;
  const Ts = normalization(src);
  const Td = normalization(dst);
  const ata = new Float64Array(81);
  const row = new Float64Array(9);
  const add = () => {
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) ata[i * 9 + j] += row[i] * row[j];
  };
  for (let k = 0; k < n; k++) {
    const x = Ts[0] * src[k][0] + Ts[2];
    const y = Ts[4] * src[k][1] + Ts[5];
    const u = Td[0] * dst[k][0] + Td[2];
    const v = Td[4] * dst[k][1] + Td[5];
    row.set([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]); add();
    row.set([0, 0, 0, x, y, 1, -v * x, -v * y, -v]); add();
  }
  const { vectors } = eigenSym(ata, 9);
  const Hn = vectors[0];
  const H = mat3mul(mat3mul(invert3(Td), Hn), Ts);
  const s = H[8] !== 0 ? 1 / H[8] : 1;
  return H.map((v) => v * s);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function rodrigues(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, -r[2], r[1], r[2], 1, -r[0], -r[1], r[0], 1];
  const kx = r[0] / th, ky = r[1] / th, kz = r[2] / th;
  const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

export function rotationToVector(R) {
  const tr = R[0] + R[4] + R[8];
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

// Rende R una rotazione vera (decomposizione polare via autovalori di RᵀR).
export function orthonormalize(M) {
  const mtm = mat3mul(transpose3(M), M);
  const { values, vectors } = eigenSym(mtm, 3);
  // (MᵀM)^(-1/2)
  const inv = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const s = 1 / Math.sqrt(Math.max(values[k], 1e-18));
    const e = vectors[k];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) inv[i * 3 + j] += s * e[i] * e[j];
  }
  const R = mat3mul(M, inv);
  if (det3(R) < 0) return null;
  return R;
}

export function project(K, R, t, X) {
  const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  return [K.fx * x / z + K.cx, K.fy * y / z + K.cy, z];
}

export function cameraCenter(R, t) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

// Posa iniziale dall'omografia piano(z=0) -> immagine.
export function poseFromHomography(H, K) {
  const Ki = [1 / K.fx, 0, -K.cx / K.fx, 0, 1 / K.fy, -K.cy / K.fy, 0, 0, 1];
  const B = mat3mul(Ki, H);
  const b1 = [B[0], B[3], B[6]];
  const b2 = [B[1], B[4], B[7]];
  const b3 = [B[2], B[5], B[8]];
  let lam = 2 / (norm(b1) + norm(b2));
  if (b3[2] * lam < 0) lam = -lam; // il bersaglio deve stare davanti
  const r1 = b1.map((v) => v * lam);
  const r2 = b2.map((v) => v * lam);
  const r3 = cross(r1, r2);
  const M = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  const R = orthonormalize(M);
  if (!R) return null;
  return { R, t: b3.map((v) => v * lam) };
}

// Ottimizzazione Levenberg–Marquardt della posa (errore di riproiezione),
// con pesi di Huber per ridurre l'effetto dei punti sbagliati.
export function refinePose(K, R0, t0, obj, img, { iterations = 12, huber = 2 } = {}) {
  let R = R0.slice();
  let t = t0.slice();
  const n = obj.length;
  const residuals = (Rc, tc, out) => {
    let e = 0;
    for (let i = 0; i < n; i++) {
      const p = project(K, Rc, tc, obj[i]);
      const du = p[0] - img[i][0];
      const dv = p[1] - img[i][1];
      out[2 * i] = du;
      out[2 * i + 1] = dv;
      e += du * du + dv * dv;
    }
    return e;
  };
  const r = new Float64Array(2 * n);
  const rp = new Float64Array(2 * n);
  const J = new Float64Array(2 * n * 6);
  let err = residuals(R, t, r);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    // jacobiano numerico rispetto a [δω (rotazione a sinistra), δt]
    for (let k = 0; k < 6; k++) {
      const h = k < 3 ? 1e-6 : 1e-4;
      let Rk = R, tk = t;
      if (k < 3) {
        const w = [0, 0, 0]; w[k] = h;
        Rk = mat3mul(rodrigues(w), R);
        tk = mat3vec(rodrigues(w), t);
      } else {
        tk = t.slice(); tk[k - 3] += h;
      }
      residuals(Rk, tk, rp);
      for (let i = 0; i < 2 * n; i++) J[i * 6 + k] = (rp[i] - r[i]) / h;
    }
    const JtJ = new Float64Array(36);
    const Jtr = new Float64Array(6);
    for (let i = 0; i < n; i++) {
      const e = Math.hypot(r[2 * i], r[2 * i + 1]);
      const w = e <= huber ? 1 : huber / e;
      for (let q = 0; q < 2; q++) {
        const row = 2 * i + q;
        for (let a = 0; a < 6; a++) {
          const ja = J[row * 6 + a] * w;
          Jtr[a] += ja * r[row];
          for (let b = a; b < 6; b++) JtJ[a * 6 + b] += ja * J[row * 6 + b];
        }
      }
    }
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) JtJ[a * 6 + b] = JtJ[b * 6 + a];
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = Float64Array.from(JtJ);
      for (let a = 0; a < 6; a++) A[a * 6 + a] *= 1 + lambda;
      const d = solve(A, Jtr.map((v) => -v), 6);
      if (!d) { lambda *= 10; continue; }
      const dR = rodrigues([d[0], d[1], d[2]]);
      const Rn = mat3mul(dR, R);
      const tn = mat3vec(dR, t);
      tn[0] += d[3]; tn[1] += d[4]; tn[2] += d[5];
      const en = residuals(Rn, tn, rp);
      if (en < err) {
        R = Rn; t = tn; err = en; r.set(rp);
        lambda = Math.max(1e-7, lambda / 4);
        improved = true;
        if (Math.hypot(d[0], d[1], d[2]) < 1e-9 && Math.hypot(d[3], d[4], d[5]) < 1e-7) it = iterations;
      } else {
        lambda *= 8;
      }
    }
    if (!improved) break;
  }
  const perPoint = new Float64Array(n);
  for (let i = 0; i < n; i++) perPoint[i] = Math.hypot(r[2 * i], r[2 * i + 1]);
  return { R, t, rms: Math.sqrt(err / Math.max(1, n)), perPoint };
}

// Stima della focale (pixel quadrati, punto principale al centro) da più
// omografie del bersaglio: vincoli di ortogonalità di Zhang con una sola incognita.
export function focalFromHomographies(Hs, cx, cy, scale) {
  const s0 = scale || 1000;
  let saa = 0, sab = 0;
  const per = [];
  for (const H of Hs) {
    // sposta l'origine al punto principale e scala le coordinate immagine
    const h = [
      (H[0] - cx * H[6]) / s0, (H[1] - cx * H[7]) / s0, (H[2] - cx * H[8]) / s0,
      (H[3] - cy * H[6]) / s0, (H[4] - cy * H[7]) / s0, (H[5] - cy * H[8]) / s0,
      H[6], H[7], H[8],
    ];
    const n = Math.hypot(h[0], h[3], h[6], h[1], h[4], h[7]);
    for (let i = 0; i < 9; i++) h[i] /= n;
    const a1 = h[0] * h[1] + h[3] * h[4];
    const b1 = h[6] * h[7];
    const a2 = h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4];
    const b2 = h[6] * h[6] - h[7] * h[7];
    saa += a1 * a1 + a2 * a2;
    sab += a1 * b1 + a2 * b2;
    const den = a1 * a1 + a2 * a2;
    const x1 = den > 0 ? -(a1 * b1 + a2 * b2) / den : 0;
    per.push(x1 > 0 ? s0 / Math.sqrt(x1) : NaN);
  }
  const x = saa > 0 ? -sab / saa : 0;
  return { f: x > 0 ? s0 / Math.sqrt(x) : NaN, perView: per };
}

// Ricerca della focale che minimizza l'errore di riproiezione su più viste.
export function refineFocal(views, f0, cx, cy, { range = 0.25, steps = 18 } = {}) {
  const cost = (f) => {
    const K = { fx: f, fy: f, cx, cy };
    let e = 0, n = 0;
    for (const v of views) {
      const p0 = poseFromHomography(v.H, K);
      if (!p0) return Infinity;
      const p = refinePose(K, p0.R, p0.t, v.obj, v.img, { iterations: 8 });
      e += p.rms * p.rms * v.obj.length;
      n += v.obj.length;
    }
    return Math.sqrt(e / Math.max(1, n));
  };
  // sezione aurea su log(f)
  let a = Math.log(f0 * (1 - range));
  let b = Math.log(f0 * (1 + range));
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = cost(Math.exp(c));
  let fd = cost(Math.exp(d));
  for (let i = 0; i < steps; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = cost(Math.exp(c)); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = cost(Math.exp(d)); }
  }
  const f = Math.exp((a + b) / 2);
  return { f, rms: cost(f) };
}

// Angoli utili per la guida: azimut e elevazione della fotocamera nel sistema del bersaglio.
export function viewAngles(R, t) {
  const C = cameraCenter(R, t);
  const rxy = Math.hypot(C[0], C[1]);
  return {
    center: C,
    azimuth: ((Math.atan2(C[1], C[0]) * 180) / Math.PI + 360) % 360,
    elevation: (Math.atan2(C[2], rxy) * 180) / Math.PI,
    distance: norm(C),
  };
}

export function rotationAngleBetween(Ra, Rb) {
  const M = mat3mul(Ra, transpose3(Rb));
  const c = Math.max(-1, Math.min(1, (M[0] + M[4] + M[8] - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

// Matrice di proiezione 3x4 riga per riga (K [R|t]).
export function projectionMatrix(K, R, t) {
  return [
    K.fx * R[0] + K.cx * R[6], K.fx * R[1] + K.cx * R[7], K.fx * R[2] + K.cx * R[8], K.fx * t[0] + K.cx * t[2],
    K.fy * R[3] + K.cy * R[6], K.fy * R[4] + K.cy * R[7], K.fy * R[5] + K.cy * R[8], K.fy * t[1] + K.cy * t[2],
    R[6], R[7], R[8], t[2],
  ];
}

// Intrinseci per un'immagine ridimensionata di un fattore `s` (nuova = vecchia / s).
export function scaleK(K, s) {
  return { fx: K.fx / s, fy: K.fy / s, cx: (K.cx + 0.5) / s - 0.5, cy: (K.cy + 0.5) / s - 0.5 };
}
