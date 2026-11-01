// Scena sintetica: piatto con il bersaglio, un oggetto di forma nota, sfondo e
// tavolo, ripresi da un telefono fermo mentre il piatto gira.
// Serve per la modalità "Demo" (provare l'app senza hardware) e per i test.

import { boardTexture, texCoord, sampleTex } from './board.js';
import { mat3vec, transpose3, rodrigues, mat3mul } from './geometry.js';

// Oggetto di prova: un pupazzo con base, corpo a righe, testa, naso e braccio.
export const DEMO_OBJECT = [
  { type: 'cyl', r: 30, z0: 0, z1: 14, color: [190, 92, 60] },
  { type: 'sph', c: [0, 0, 40], r: 26, color: [225, 175, 60], stripes: true },
  { type: 'sph', c: [0, 0, 78], r: 16, color: [90, 165, 95] },
  { type: 'sph', c: [15, 0, 80], r: 6, color: [200, 40, 40] },
  { type: 'sph', c: [22, 12, 46], r: 9, color: [60, 90, 190] },
];

export function insideObject(parts, x, y, z) {
  for (const p of parts) {
    if (p.type === 'sph') {
      if ((x - p.c[0]) ** 2 + (y - p.c[1]) ** 2 + (z - p.c[2]) ** 2 <= p.r * p.r) return true;
    } else if (p.type === 'cyl') {
      if (z >= p.z0 && z <= p.z1 && x * x + y * y <= p.r * p.r) return true;
    }
  }
  return false;
}

export function makeScene(board, { parts = DEMO_OBJECT, backdrop = [62, 104, 168], shadows = true } = {}) {
  const tex = boardTexture(board, { ppm: 4, sigmas: [0.3] });
  return { board, tex, parts, backdrop, shadows, plateR: board.radius + 12, tableZ: -6, wallY: 260, light: normalize([-0.4, -0.5, 0.77]) };
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Fotocamera fissa che guarda il centro del piatto. Restituisce la posa nel mondo.
export function fixedCamera({ w = 960, h = 540, elevation = 30, distance = 360, targetZ = 40, focal = 0.8 } = {}) {
  const e = (elevation * Math.PI) / 180;
  const C = [0, -distance * Math.cos(e), targetZ + distance * Math.sin(e)];
  const fwd = normalize([-C[0], -C[1], targetZ - C[2]]);
  const right = normalize([fwd[1], -fwd[0], 0]);
  const down = [
    fwd[1] * right[2] - fwd[2] * right[1],
    fwd[2] * right[0] - fwd[0] * right[2],
    fwd[0] * right[1] - fwd[1] * right[0],
  ];
  const Rwc = [...right, ...down, ...fwd];
  const t = mat3vec(Rwc, C).map((v) => -v);
  const f = focal * Math.max(w, h);
  return { w, h, K: { fx: f, fy: f, cx: w / 2 - 0.5, cy: h / 2 - 0.5 }, Rwc, twc: t, C };
}

// Posa bersaglio -> fotocamera quando il piatto è ruotato di `angle` gradi.
export function poseAt(cam, angle) {
  const Rz = rodrigues([0, 0, (angle * Math.PI) / 180]);
  return { R: mat3mul(cam.Rwc, Rz), t: cam.twc.slice() };
}

export function hitParts(parts, o, d, tmax) {
  let best = tmax, part = null, normal = null;
  for (const p of parts) {
    if (p.type === 'sph') {
      const ox = o[0] - p.c[0], oy = o[1] - p.c[1], oz = o[2] - p.c[2];
      const b = ox * d[0] + oy * d[1] + oz * d[2];
      const c = ox * ox + oy * oy + oz * oz - p.r * p.r;
      const disc = b * b - c;
      if (disc < 0) continue;
      const s = Math.sqrt(disc);
      let t = -b - s;
      if (t < 1e-3) t = -b + s;
      if (t > 1e-3 && t < best) {
        best = t; part = p;
        normal = [(ox + t * d[0]) / p.r, (oy + t * d[1]) / p.r, (oz + t * d[2]) / p.r];
      }
    } else if (p.type === 'cyl') {
      const a = d[0] * d[0] + d[1] * d[1];
      if (a > 1e-12) {
        const b = o[0] * d[0] + o[1] * d[1];
        const c = o[0] * o[0] + o[1] * o[1] - p.r * p.r;
        const disc = b * b - a * c;
        if (disc >= 0) {
          const s = Math.sqrt(disc);
          for (const t of [(-b - s) / a, (-b + s) / a]) {
            const z = o[2] + t * d[2];
            if (t > 1e-3 && t < best && z >= p.z0 && z <= p.z1) {
              best = t; part = p;
              normal = [(o[0] + t * d[0]) / p.r, (o[1] + t * d[1]) / p.r, 0];
              break;
            }
          }
        }
      }
      if (Math.abs(d[2]) > 1e-9) {
        const t = (p.z1 - o[2]) / d[2];
        const x = o[0] + t * d[0], y = o[1] + t * d[1];
        if (t > 1e-3 && t < best && x * x + y * y <= p.r * p.r) { best = t; part = p; normal = [0, 0, 1]; }
      }
    }
  }
  return part ? { t: best, part, normal } : null;
}

// Disegna la vista con il piatto ruotato di `angle` gradi. Restituisce RGBA.
export function renderView(scene, cam, angle, { noise = 3, seed = 1 } = {}) {
  const { w, h, K, Rwc, C } = cam;
  const th = (angle * Math.PI) / 180;
  const cs = Math.cos(th), sn = Math.sin(th);
  const toBoard = (v) => [cs * v[0] + sn * v[1], -sn * v[0] + cs * v[1], v[2]];
  const toWorld = (v) => [cs * v[0] - sn * v[1], sn * v[0] + cs * v[1], v[2]];
  const Rt = transpose3(Rwc);
  const oB = toBoard(C);
  const L = scene.light;
  const LB = toBoard(L);
  const out = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const { tex, board } = scene;
  const ambient = 0.55;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const dc = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1];
      const dw = normalize(mat3vec(Rt, dc));
      const dB = toBoard(dw);
      let col;
      let tBest = Infinity;
      const obj = hitParts(scene.parts, oB, dB, Infinity);
      if (obj) {
        tBest = obj.t;
        const nW = toWorld(obj.normal);
        const lam = Math.max(0, nW[0] * L[0] + nW[1] * L[1] + nW[2] * L[2]);
        const sh = ambient + (1 - ambient) * lam;
        let base = obj.part.color;
        if (obj.part.stripes) {
          const z = oB[2] + obj.t * dB[2];
          const k = Math.sin(z * 0.45) > 0 ? 1 : 0.7;
          base = base.map((c) => c * k);
        }
        col = base.map((c) => c * sh);
      }
      if (!obj) {
        // piano del piatto (z = 0)
        let done = false;
        if (dw[2] < 0) {
          const t = -C[2] / dw[2];
          const P = [C[0] + t * dw[0], C[1] + t * dw[1], 0];
          const r = Math.hypot(P[0], P[1]);
          if (r <= scene.plateR && P[1] < scene.wallY) {
            let shade = ambient + (1 - ambient) * L[2];
            if (scene.shadows) {
              const PB = toBoard(P);
              if (hitParts(scene.parts, PB, LB, Infinity)) shade = ambient * 0.9;
            }
            if (r <= board.radius) {
              const PB = toBoard(P);
              const [tx, ty] = texCoord(tex, PB[0], PB[1]);
              const val = sampleTex(tex.base, tex.size, tx, ty);
              const g = 18 + 222 * val;
              col = [g * shade, g * shade, g * 0.97 * shade];
            } else {
              col = [120 * shade, 120 * shade, 125 * shade];
            }
            done = true;
          } else if (dw[2] < 0) {
            const t2 = (scene.tableZ - C[2]) / dw[2];
            const Q = [C[0] + t2 * dw[0], C[1] + t2 * dw[1]];
            if (Q[1] < scene.wallY) {
              const sh = ambient + (1 - ambient) * L[2];
              col = [200 * sh, 180 * sh, 150 * sh];
              done = true;
            }
          }
        }
        if (!done) {
          const tw = dw[1] > 0 ? (scene.wallY - C[1]) / dw[1] : Infinity;
          const zz = C[2] + tw * dw[2];
          const g = 1 - Math.min(0.25, Math.max(0, zz) / 1200);
          col = scene.backdrop.map((c) => c * g);
        }
      }
      const i = (v * w + u) * 4;
      out[i] = col[0] + noise * rnd() * 2;
      out[i + 1] = col[1] + noise * rnd() * 2;
      out[i + 2] = col[2] + noise * rnd() * 2;
      out[i + 3] = 255;
    }
  }
  return out;
}
