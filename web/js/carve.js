// Scultura del volume dalle silhouette (visual hull) con campo di distanza.
// Ogni voxel tiene i k valori più piccoli (in decimi di mm) della distanza con
// segno dal contorno della silhouette, su tutte le viste che lo vedono.
// Il k-esimo più piccolo rende il risultato tollerante a k-1 viste sbagliate.

import { projectionMatrix } from './geometry.js';

const EMPTY = 32767;

// Sfocatura gaussiana separabile del campo (sigma in voxel): toglie il rumore
// alla scala del voxel senza spostare le superfici piane.
function blur3d(data, nx, ny, nz, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const dims = [nx, ny, nz];
  const strides = [1, nx, nx * ny];
  const line = new Float32Array(Math.max(nx, ny, nz));
  for (let axis = 0; axis < 3; axis++) {
    const n = dims[axis], st = strides[axis];
    const o1 = axis === 0 ? 1 : 0, o2 = axis === 2 ? 1 : 2;
    const n1 = dims[o1], n2 = dims[o2], s1 = strides[o1], s2 = strides[o2];
    for (let b = 0; b < n2; b++) {
      for (let a = 0; a < n1; a++) {
        const base = a * s1 + b * s2;
        for (let i = 0; i < n; i++) line[i] = data[base + i * st];
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let j = -r; j <= r; j++) {
            const q = i + j < 0 ? 0 : i + j >= n ? n - 1 : i + j;
            acc += line[q] * k[j + r];
          }
          data[base + i * st] = acc;
        }
      }
    }
  }
}

export class VoxelVolume {
  constructor({ radius = 65, height = 120, voxel = 1, k = 2 } = {}) {
    this.radius = radius;
    this.height = height;
    this.vs = voxel;
    this.k = Math.max(1, Math.min(3, k | 0));
    this.nx = Math.ceil((2 * radius) / voxel);
    this.ny = this.nx;
    this.nz = Math.ceil(height / voxel);
    this.ox = -this.nx * voxel / 2;
    this.oy = -this.ny * voxel / 2;
    const n = this.nx * this.ny * this.nz;
    this.count = n;
    this.vals = [];
    for (let i = 0; i < this.k; i++) this.vals.push(new Int16Array(n).fill(EMPTY));
    this.seen = new Uint8Array(n);
    this.dead = new Uint8Array(n);
    // quante viste hanno visto il voxel cadere su un pixel sicuramente "oggetto"
    this.evidence = new Uint8Array(n);
    this.useEvidence = false;
    this.views = 0;
    // fuori dal cilindro: vuoto per sempre
    const r2 = radius * radius;
    for (let j = 0; j < this.ny; j++) {
      const y = this.oy + (j + 0.5) * voxel;
      for (let i = 0; i < this.nx; i++) {
        const x = this.ox + (i + 0.5) * voxel;
        if (x * x + y * y > r2) for (let l = 0; l < this.nz; l++) this.dead[i + this.nx * (j + this.ny * l)] = 2;
      }
    }
  }

  // Integra una vista: sdf in pixel (positivo dentro), K/R/t riferiti a quella immagine.
  // mask (facoltativa): 1 = pixel sicuramente oggetto, per contare le prove.
  integrate(sdf, w, h, K, R, t, mask = null) {
    const P = projectionMatrix(K, R, t);
    const { nx, ny, nz, vs, ox, oy, k, seen, dead, evidence } = this;
    if (mask) this.useEvidence = true;
    const v0 = this.vals[0], v1 = this.vals[1], v2 = this.vals[2];
    const invF = 1 / K.fx;
    const deadLim = -Math.max(20, Math.round(25 * vs));
    const dU = P[0] * vs, dV = P[4] * vs, dW = P[8] * vs;
    const wm = w - 1.001, hm = h - 1.001;
    let idx = 0;
    for (let l = 0; l < nz; l++) {
      const z = (l + 0.5) * vs;
      for (let j = 0; j < ny; j++) {
        const y = oy + (j + 0.5) * vs;
        const x = ox + 0.5 * vs;
        let U = P[0] * x + P[1] * y + P[2] * z + P[3];
        let V = P[4] * x + P[5] * y + P[6] * z + P[7];
        let W = P[8] * x + P[9] * y + P[10] * z + P[11];
        for (let i = 0; i < nx; i++, idx++, U += dU, V += dV, W += dW) {
          if (dead[idx] || W <= 1) continue;
          const u = U / W, v = V / W;
          if (u < 0 || v < 0 || u > wm || v > hm) continue;
          const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
          const p = y0 * w + x0;
          const a = sdf[p] + (sdf[p + 1] - sdf[p]) * fx;
          const b = sdf[p + w] + (sdf[p + w + 1] - sdf[p + w]) * fx;
          let q = Math.round((a + (b - a) * fy) * W * invF * 10);
          if (q < -32000) q = -32000; else if (q > 32000) q = 32000;
          if (seen[idx] < 255) seen[idx]++;
          if (mask && evidence[idx] < 255 && mask[Math.round(v) * w + Math.round(u)] === 1) evidence[idx]++;
          if (k === 1) {
            if (q < v0[idx]) v0[idx] = q;
            if (v0[idx] < deadLim) dead[idx] = 1;
          } else if (k === 2) {
            if (q < v0[idx]) { v1[idx] = v0[idx]; v0[idx] = q; } else if (q < v1[idx]) v1[idx] = q;
            if (v1[idx] < deadLim) dead[idx] = 1;
          } else {
            if (q < v0[idx]) { v2[idx] = v1[idx]; v1[idx] = v0[idx]; v0[idx] = q; }
            else if (q < v1[idx]) { v2[idx] = v1[idx]; v1[idx] = q; }
            else if (q < v2[idx]) v2[idx] = q;
            if (v2[idx] < deadLim) dead[idx] = 1;
          }
        }
      }
    }
    this.views++;
  }

  // Un voxel conta solo se è stato visto abbastanza e, quando si contano le prove,
  // se almeno una vista lo ha visto su un pixel sicuramente "oggetto": così le zone
  // che nessuna vista poteva giudicare (sfondo sconosciuto) non diventano solido.
  usable(idx, minSeen) {
    if (this.dead[idx] === 2 || this.seen[idx] < minSeen) return false;
    return !this.useEvidence || this.evidence[idx] > 0;
  }

  // Campo scalare in mm (positivo = dentro) pronto per l'estrazione della superficie.
  // `step` > 1 riduce la risoluzione (anteprima veloce).
  field({ minSeen = 3, step = 1, blur = 0 } = {}) {
    const { nx, ny, nz, vs } = this;
    const vk = this.vals[this.k - 1];
    const fx = Math.floor(nx / step), fy = Math.floor(ny / step), fz = Math.floor(nz / step);
    const out = new Float32Array(fx * fy * fz);
    const out0 = -vs;
    for (let l = 0; l < fz; l++) {
      for (let j = 0; j < fy; j++) {
        for (let i = 0; i < fx; i++) {
          let acc = 0, cnt = 0;
          for (let dl = 0; dl < step; dl++) {
            for (let dj = 0; dj < step; dj++) {
              for (let di = 0; di < step; di++) {
                const idx = (i * step + di) + nx * ((j * step + dj) + ny * (l * step + dl));
                let val;
                if (!this.usable(idx, minSeen)) val = out0;
                else val = vk[idx] === EMPTY ? out0 : vk[idx] / 10;
                acc += val; cnt++;
              }
            }
          }
          out[i + fx * (j + fy * l)] = acc / cnt;
        }
      }
    }
    if (blur > 0) blur3d(out, fx, fy, fz, blur);
    return { data: out, nx: fx, ny: fy, nz: fz, vs: vs * step, ox: this.ox, oy: this.oy, oz: 0 };
  }

  // Volume occupato, ingombro e se l'oggetto tocca i limiti del volume di scansione.
  stats({ minSeen = 3 } = {}) {
    const { nx, ny, nz, vs } = this;
    const vk = this.vals[this.k - 1];
    let n = 0;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = -Infinity;
    let touchTop = 0, touchSide = 0;
    const rEdge = (this.radius - 1.5 * vs) ** 2;
    for (let l = 0; l < nz; l++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * l);
          if (!this.usable(idx, minSeen) || vk[idx] <= 0 || vk[idx] === EMPTY) continue;
          n++;
          const x = this.ox + (i + 0.5) * vs, y = this.oy + (j + 0.5) * vs, z = (l + 0.5) * vs;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z > z1) z1 = z;
          if (l === nz - 1) touchTop++;
          if (x * x + y * y > rEdge) touchSide++;
        }
      }
    }
    return {
      volumeCm3: (n * vs * vs * vs) / 1000,
      size: n ? [x1 - x0 + vs, y1 - y0 + vs, z1 + vs / 2] : [0, 0, 0],
      touchTop: touchTop > 3,
      touchSide: touchSide > 20,
      views: this.views,
    };
  }
}
