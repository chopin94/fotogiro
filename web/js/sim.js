// Scena sintetica: piatto con il bersaglio, un oggetto di forma nota, sfondo e
// tavolo, ripresi da un telefono fermo mentre il piatto gira, oppure da un
// telefono tenuto in mano che gira intorno (anche in una stanza disordinata).
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

// clutter: la "stanza normale" — pareti e tavolo pieni di oggetti colorati,
// anche degli stessi colori dell'oggetto da scansionare.
export function makeScene(board, { parts = DEMO_OBJECT, backdrop = [62, 104, 168], shadows = true, clutter = false, seed = 7 } = {}) {
  const tex = boardTexture(board, { ppm: 4, sigmas: [0.3] });
  return {
    board, tex, parts, backdrop, shadows, clutter, seed,
    plateR: board.radius + 12, tableZ: -6, roomR: 650, light: normalize([-0.4, -0.5, 0.77]),
  };
}

const PALETTE = [
  [225, 175, 60], [190, 92, 60], [90, 165, 95], [60, 90, 190], [200, 40, 40], [232, 232, 226],
  [40, 40, 46], [150, 120, 90], [120, 160, 200], [200, 200, 120], [170, 60, 140], [95, 95, 100],
];

function hash3(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Colore di una superficie "disordinata" in coordinate (u, v) in mm.
function clutterColor(u, v, seed, cell) {
  const ci = Math.floor(u / cell), cj = Math.floor(v / cell);
  const base = PALETTE[Math.floor(hash3(ci, cj, seed) * PALETTE.length)];
  // un rettangolo interno di un altro colore: bordi e dettagli come negli oggetti veri
  const fu = u / cell - ci, fv = v / cell - cj;
  const a = 0.15 + 0.3 * hash3(ci, cj, seed + 1), b = 0.55 + 0.3 * hash3(ci, cj, seed + 2);
  if (fu > a && fu < b && fv > a && fv < b) return PALETTE[Math.floor(hash3(ci, cj, seed + 3) * PALETTE.length)];
  const k = 0.75 + 0.25 * hash3(ci, cj, seed + 4);
  return base.map((c) => c * k);
}

// Telefono tenuto in mano: guarda il centro del bersaglio da azimut/elevazione dati.
// Restituisce la posa bersaglio -> fotocamera.
export function orbitCamera({ w = 960, h = 540, azimuth = 0, elevation = 35, distance = 380, targetZ = 40, focal = 0.8, roll = 0, offset = [0, 0] } = {}) {
  const a = (azimuth * Math.PI) / 180, e = (Math.min(88, elevation) * Math.PI) / 180;
  const C = [distance * Math.cos(e) * Math.cos(a), distance * Math.cos(e) * Math.sin(a), targetZ + distance * Math.sin(e)];
  const fwd = normalize([offset[0] - C[0], offset[1] - C[1], targetZ - C[2]]);
  let right = normalize([fwd[1], -fwd[0], 0]);
  let down = [fwd[1] * right[2] - fwd[2] * right[1], fwd[2] * right[0] - fwd[0] * right[2], fwd[0] * right[1] - fwd[1] * right[0]];
  if (roll) {
    const r = (roll * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const nr = right.map((x, i) => c * x + s * down[i]);
    down = down.map((x, i) => -s * right[i] + c * x);
    right = nr;
  }
  const R = [...right, ...down, ...fwd];
  const t = mat3vec(R, C).map((v) => -v);
  const f = focal * Math.max(w, h);
  return { w, h, K: { fx: f, fy: f, cx: w / 2 - 0.5, cy: h / 2 - 0.5 }, R, t, C };
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

// Disegna la vista con il piatto ruotato di `angle` gradi e il telefono fermo. Restituisce RGBA.
export function renderView(scene, cam, angle, opts = {}) {
  const { R, t } = poseAt(cam, angle);
  return renderPose(scene, cam.K, R, t, cam.w, cam.h, { ...opts, roomAngle: angle });
}

// Disegna la vista da una posa qualsiasi (bersaglio -> fotocamera).
// roomAngle: di quanto la stanza è ruotata rispetto al bersaglio (piatto che gira);
// 0 = stanza ferma rispetto al bersaglio (telefono in mano che gira intorno).
export function renderPose(scene, K, R, t, w, h, { roomAngle = 0, noise = 3, seed = 1 } = {}) {
  const th = (roomAngle * Math.PI) / 180;
  const cs = Math.cos(th), sn = Math.sin(th);
  const toBoard = (v) => [cs * v[0] + sn * v[1], -sn * v[0] + cs * v[1], v[2]];
  const toRoom = (v) => [cs * v[0] - sn * v[1], sn * v[0] + cs * v[1], v[2]];
  const Rt = transpose3(R);
  const oB = mat3vec(Rt, t).map((v) => -v); // centro della fotocamera nel bersaglio
  const oR = toRoom(oB);
  const L = scene.light; // luce ferma nella stanza
  const LB = toBoard(L);
  const out = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const { tex, board } = scene;
  const ambient = 0.55;
  const flat = ambient + (1 - ambient) * L[2];
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const dB = normalize(mat3vec(Rt, [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]));
      const dR = toRoom(dB);
      let col = null;
      const obj = hitParts(scene.parts, oB, dB, Infinity);
      if (obj) {
        const lam = Math.max(0, obj.normal[0] * LB[0] + obj.normal[1] * LB[1] + obj.normal[2] * LB[2]);
        const sh = ambient + (1 - ambient) * lam;
        let base = obj.part.color;
        if (obj.part.stripes) {
          const z = oB[2] + obj.t * dB[2];
          const k = Math.sin(z * 0.45) > 0 ? 1 : 0.7;
          base = base.map((c) => c * k);
        }
        col = base.map((c) => c * sh);
      } else if (dB[2] < 0) {
        // piatto e bersaglio (z = 0, ruotano con il bersaglio)
        const tp = -oB[2] / dB[2];
        const PB = [oB[0] + tp * dB[0], oB[1] + tp * dB[1], 0];
        const r = Math.hypot(PB[0], PB[1]);
        if (r <= scene.plateR) {
          let shade = flat;
          if (scene.shadows && hitParts(scene.parts, PB, LB, Infinity)) shade = ambient * 0.9;
          if (r <= board.radius) {
            const [tx, ty] = texCoord(tex, PB[0], PB[1]);
            const g = 18 + 222 * sampleTex(tex.base, tex.size, tx, ty);
            col = [g * shade, g * shade, g * 0.97 * shade];
          } else {
            col = [120 * shade, 120 * shade, 125 * shade];
          }
        } else {
          // tavolo (fermo nella stanza)
          const tt = (scene.tableZ - oR[2]) / dR[2];
          const Q = [oR[0] + tt * dR[0], oR[1] + tt * dR[1]];
          if (Math.hypot(Q[0], Q[1]) < scene.roomR) {
            let base = [200, 180, 150];
            if (scene.clutter) {
              const ci = Math.floor(Q[0] / 90), cj = Math.floor(Q[1] / 90);
              if (Math.hypot(Q[0], Q[1]) > scene.plateR + 25 && hash3(ci, cj, scene.seed + 9) < 0.4) base = clutterColor(Q[0], Q[1], scene.seed + 11, 90);
            }
            col = base.map((c) => c * flat);
          }
        }
      }
      if (!col) {
        // parete cilindrica della stanza
        const a = dR[0] * dR[0] + dR[1] * dR[1];
        const b = oR[0] * dR[0] + oR[1] * dR[1];
        const c = oR[0] * oR[0] + oR[1] * oR[1] - scene.roomR * scene.roomR;
        const tw = a > 1e-12 ? (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a : 1e6;
        const P = [oR[0] + tw * dR[0], oR[1] + tw * dR[1], oR[2] + tw * dR[2]];
        if (scene.clutter) {
          const arc = (Math.atan2(P[1], P[0]) + Math.PI) * scene.roomR;
          col = clutterColor(arc, P[2] + 1000, scene.seed, 70);
        } else {
          const g = 1 - Math.min(0.25, Math.max(0, P[2]) / 1200);
          col = scene.backdrop.map((x) => x * g);
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
