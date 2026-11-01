// La pipeline completa, indipendente dal browser (gira nel worker e nei test):
// fotogramma -> marker -> posa -> (fotogramma chiave) silhouette -> scultura.

import { makeBoard } from './board.js';
import { MarkerDetector } from './markers.js';
import {
  homography, poseFromHomography, refinePose, focalFromHomographies, refineFocal,
  viewAngles, rotationAngleBetween, scaleK,
} from './geometry.js';
import { Segmenter, signedDistance } from './segment.js';
import { VoxelVolume } from './carve.js';
import { Coverage } from './coverage.js';
import { extractSurface, keepLargestComponents, taubinSmooth, vertexNormals, meshReport } from './mesh.js';

export const DEFAULTS = {
  boardDiameter: 200,
  volRadius: 0, // 0 = area libera del bersaglio
  volHeight: 120,
  voxel: 1.0,
  tolerance: 2, // k: viste sbagliate tollerate + 1
  azStep: 5,
  elTol: 8,
  maxSpeed: 12, // gradi al secondo: oltre, il fotogramma è mosso
  sensitivity: 1,
  fillHoles: true,
  shadows: false,
  maskWidth: 480,
  detectWidth: 1280,
  focal: 0, // focale normalizzata (f / lato lungo); 0 = calibrazione automatica
  calibViews: 12,
};

// Riduzione di un fattore intero con media dei pixel.
export function downscaleRGBA(src, w, h, s) {
  if (s === 1) return { data: src, w, h };
  const W = Math.floor(w / s), H = Math.floor(h / s);
  const out = new Uint8ClampedArray(W * H * 4);
  const n = s * s;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < s; dy++) {
        let j = ((y * s + dy) * w + x * s) * 4;
        for (let dx = 0; dx < s; dx++, j += 4) { r += src[j]; g += src[j + 1]; b += src[j + 2]; }
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, w: W, h: H };
}

function grayFrom(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

export class Scanner {
  constructor(settings = {}) {
    this.s = { ...DEFAULTS, ...settings };
    this.board = makeBoard({ diameter: this.s.boardDiameter });
    this.detector = new MarkerDetector();
    this.segmenter = new Segmenter(this.board);
    this.reset();
  }

  get volumeSpec() {
    const r = this.s.volRadius > 0 ? this.s.volRadius : Math.floor(this.board.clearRadius);
    return { radius: r, height: this.s.volHeight };
  }

  reset() {
    const v = this.volumeSpec;
    this.volume = new VoxelVolume({ radius: v.radius, height: v.height, voxel: this.s.voxel, k: this.s.tolerance });
    this.coverage = new Coverage();
    this.calib = [];
    this.backlog = [];
    this.last = null;
    this.focalN = this.s.focal > 0 ? this.s.focal : 0;
    this.keyCount = 0;
  }

  // f in pixel per un'immagine con lato lungo `maxDim`.
  focalFor(maxDim) {
    return (this.focalN || 0.8) * maxDim;
  }

  processFrame(rgba, w, h, time = 0, { force = false } = {}) {
    const s = this.s;
    const t0 = performance.now();
    const timings = {};
    const sd = Math.max(1, Math.ceil(w / s.detectWidth - 0.01));
    const det = downscaleRGBA(rgba, w, h, sd);
    const gray = grayFrom(det.data, det.w, det.h);
    const found = this.detector.detect(gray, det.w, det.h);
    timings.detect = performance.now() - t0;
    const toOrig = (p) => [(p[0] + 0.5) * sd - 0.5, (p[1] + 0.5) * sd - 0.5];
    const markers = found.map((m) => ({ id: m.id, corners: m.corners.map(toOrig) }));
    const res = { ok: false, markers, calibrating: !this.focalN, keyframe: false, warnings: [], timings, detectSize: [det.w, det.h] };
    const obj = [], img = [];
    for (const m of found) {
      const bm = this.board.byId.get(m.id);
      if (!bm) continue;
      for (let c = 0; c < 4; c++) { obj.push([bm.corners[c][0], bm.corners[c][1], 0]); img.push(m.corners[c]); }
    }
    res.markerCount = obj.length / 4;
    if (obj.length < 8) { res.reason = obj.length ? 'pochi marker visibili' : 'bersaglio non trovato'; return res; }
    const H = homography(obj.map((p) => [p[0], p[1]]), img);
    if (!H) { res.reason = 'posa non calcolabile'; return res; }
    const maxDet = Math.max(det.w, det.h);
    const cx = (det.w - 1) / 2, cy = (det.h - 1) / 2;

    // calibrazione automatica della focale
    if (!this.focalN && obj.length >= 16) {
      const lastC = this.calib[this.calib.length - 1];
      if (!lastC || time - lastC.time > 0.25 || force) this.calib.push({ H, obj, img, time });
      if (this.calib.length >= s.calibViews) this.tryCalibrate(cx, cy, maxDet);
      res.calibrating = !this.focalN;
      res.calibProgress = Math.min(1, this.calib.length / s.calibViews);
    }

    const f = this.focalFor(maxDet);
    const K = { fx: f, fy: f, cx, cy };
    const tp = performance.now();
    const pose = this.solvePose(H, K, obj, img);
    timings.pose = performance.now() - tp;
    if (!pose) { res.reason = 'posa instabile'; return res; }
    const ang = viewAngles(pose.R, pose.t);
    if (ang.center[2] <= 0) { res.reason = 'posa non valida'; return res; }
    let speed = 0;
    if (this.last && time > this.last.time) speed = rotationAngleBetween(pose.R, this.last.R) / (time - this.last.time);
    this.last = { R: pose.R, time };
    const Korig = scaleK(K, 1 / sd);
    Object.assign(res, {
      ok: true, R: pose.R, t: pose.t, K: Korig, rms: pose.rms * sd, azimuth: ang.azimuth, elevation: ang.elevation,
      distance: ang.distance, speed, f: f * sd, markerCount: pose.markers,
    });
    if (speed > s.maxSpeed && !force) res.warnings.push('troppo veloce');

    const wantKey = force || (speed <= s.maxSpeed && this.coverage.needs(ang.azimuth, ang.elevation, s.azStep, s.elTol));
    if (wantKey && pose.rms < 2.0 && pose.markers >= 3) {
      const sm = Math.max(1, Math.ceil(w / s.maskWidth - 0.01));
      const small = downscaleRGBA(rgba, w, h, sm);
      const item = { rgba: small.data, w: small.w, h: small.h, obj, img, sd, sm, H, maxDet, cx, cy };
      this.coverage.add(ang.azimuth, ang.elevation, { C: ang.center });
      this.keyCount++;
      res.keyframe = true;
      if (this.focalN) {
        const out = this.integrate(item, pose, timings);
        if (out) { res.mask = out.mask; res.maskW = small.w; res.maskH = small.h; if (out.warn) res.warnings.push(out.warn); }
        else res.warnings.push('silhouette non calcolata (bersaglio poco visibile)');
      } else {
        this.backlog.push(item);
      }
    }
    if (this.focalN && this.backlog.length) {
      const tb = performance.now();
      const n = this.backlog.length;
      this.flushBacklog();
      timings.backlog = performance.now() - tb;
      res.flushed = n;
    }
    res.coverage = this.coverage.summary();
    res.views = this.volume.views;
    res.markerIds = found.map((m) => m.id).sort((a, b) => a - b);
    timings.total = performance.now() - t0;
    return res;
  }

  solvePose(H, K, obj, img) {
    const p0 = poseFromHomography(H, K);
    if (!p0) return null;
    let p = refinePose(K, p0.R, p0.t, obj, img);
    let o = obj, im = img;
    // scarta i marker che non tornano con gli altri e ricalcola
    const nm = obj.length / 4;
    const errs = [];
    for (let m = 0; m < nm; m++) errs.push((p.perPoint[4 * m] + p.perPoint[4 * m + 1] + p.perPoint[4 * m + 2] + p.perPoint[4 * m + 3]) / 4);
    const med = [...errs].sort((a, b) => a - b)[nm >> 1];
    const bad = errs.map((e) => e > Math.max(2.5, 3 * med));
    if (bad.some(Boolean) && nm - bad.filter(Boolean).length >= 2) {
      o = []; im = [];
      for (let m = 0; m < nm; m++) if (!bad[m]) for (let c = 0; c < 4; c++) { o.push(obj[4 * m + c]); im.push(img[4 * m + c]); }
      p = refinePose(K, p.R, p.t, o, im);
    }
    return { ...p, markers: o.length / 4 };
  }

  tryCalibrate(cx, cy, maxDim) {
    const views = this.calib.slice(-24);
    const est = focalFromHomographies(views.map((v) => v.H), cx, cy, maxDim);
    if (!(est.f > 0.3 * maxDim && est.f < 3 * maxDim)) {
      if (this.calib.length > 60) this.calib = this.calib.slice(-24);
      return;
    }
    const ref = refineFocal(views, est.f, cx, cy);
    if (ref.rms > 2.5) return;
    this.focalN = ref.f / maxDim;
    this.calibRms = ref.rms;
  }

  integrate(item, pose, timings = {}) {
    const s = this.s;
    const Kmask = scaleK(scaleK({ fx: this.focalFor(item.maxDet), fy: this.focalFor(item.maxDet), cx: item.cx, cy: item.cy }, 1 / item.sd), item.sm);
    const ts = performance.now();
    const seg = this.segmenter.segment(item.rgba, item.w, item.h, Kmask, pose.R, pose.t, this.volumeSpec, {
      sensitivity: s.sensitivity, fillHoles: s.fillHoles, shadows: s.shadows,
    });
    timings.segment = performance.now() - ts;
    if (!seg || !seg.white) return null;
    const tc = performance.now();
    const sdf = signedDistance(seg.mask, item.w, item.h);
    this.volume.integrate(sdf, item.w, item.h, Kmask, pose.R, pose.t);
    timings.carve = performance.now() - tc;
    return seg;
  }

  flushBacklog() {
    for (const item of this.backlog) {
      const f = this.focalFor(item.maxDet);
      const K = { fx: f, fy: f, cx: item.cx, cy: item.cy };
      const pose = this.solvePose(item.H, K, item.obj, item.img);
      if (pose) this.integrate(item, pose);
    }
    this.backlog = [];
  }

  previewMesh() {
    const field = this.volume.field({ step: 2 });
    const mesh = extractSurface(field);
    return { ...mesh, normals: vertexNormals(mesh) };
  }

  finalMesh({ smooth = 6 } = {}) {
    if (this.backlog.length && this.focalN) this.flushBacklog();
    const field = this.volume.field({ step: 1, blur: smooth > 0 ? 0.9 : 0 });
    let mesh = extractSurface(field);
    mesh = keepLargestComponents(mesh, 0.05);
    if (smooth > 0) mesh = taubinSmooth(mesh, smooth);
    const report = meshReport(mesh);
    return { ...mesh, normals: vertexNormals(mesh), report };
  }

  stats() {
    return { ...this.volume.stats(), focalN: this.focalN, keyframes: this.keyCount, pending: this.backlog.length };
  }
}
