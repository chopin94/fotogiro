// Worker: tutta l'elaborazione pesante fuori dal thread dell'interfaccia.

import { Scanner } from './scanner.js';
import { toSTL, toOBJ, placeOnBed } from './mesh.js';

let scanner = null;
let lastPreview = 0;
let keysSincePreview = 0;
let lastFinal = null;
// fotogrammi chiave registrati (JPEG) per "Esporta scansione"
// (servono anche al secondo passaggio di "Genera modello")
let recorded = [];
let recordOn = false;
const MAX_RECORDED = 300;

// Rielabora i fotogrammi registrati con i colori dell'oggetto ormai noti.
async function refine() {
  const s2 = scanner.refined();
  for (let k = 0; k < recorded.length; k++) {
    const f = recorded[k];
    const bmp = await createImageBitmap(f.blob);
    const oc = new OffscreenCanvas(f.w, f.h);
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, f.w, f.h);
    s2.processFrame(img.data, f.w, f.h, f.time, { force: true });
    if (k % 3 === 2 || k === recorded.length - 1) postMessage({ type: 'progress', f: (k + 1) / recorded.length, label: 'Secondo passaggio' });
  }
  return s2;
}

async function record(buf, w, h, time, res) {
  if (typeof OffscreenCanvas === 'undefined' || recorded.length >= MAX_RECORDED) return;
  const oc = new OffscreenCanvas(w, h);
  oc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  recorded.push({
    blob, w, h, time,
    meta: res.ok
      ? { ok: true, azimuth: res.azimuth, elevation: res.elevation, rms: res.rms, R: res.R, t: res.t, K: res.K, markerIds: res.markerIds, background: res.background }
      : { ok: false, reason: res.reason, markerIds: res.markerIds },
  });
}

function sendPreview() {
  const m = scanner.previewMesh();
  const stats = scanner.stats();
  postMessage({ type: 'mesh', positions: m.positions, indices: m.indices, normals: m.normals, stats }, [m.positions.buffer, m.indices.buffer, m.normals.buffer]);
  lastPreview = performance.now();
  keysSincePreview = 0;
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      scanner = new Scanner(msg.settings);
      recorded = [];
      recordOn = !!msg.record;
      postMessage({ type: 'ready', board: { diameter: scanner.board.diameter, radius: scanner.board.radius, clearRadius: scanner.board.clearRadius, count: scanner.board.count }, volume: scanner.volumeSpec, focalN: scanner.focalN });
    } else if (msg.type === 'frame') {
      const wasCalibrated = !!scanner.focalN;
      const res = scanner.processFrame(new Uint8ClampedArray(msg.buf), msg.w, msg.h, msg.time, { force: msg.force });
      const out = { type: 'frame', id: msg.id, res: { ...res, mask: undefined } };
      const transfer = [];
      if (res.mask) { out.mask = res.mask; out.maskW = res.maskW; out.maskH = res.maskH; transfer.push(res.mask.buffer); }
      postMessage(out, transfer);
      if (!wasCalibrated && scanner.focalN) postMessage({ type: 'focal', focalN: scanner.focalN, rms: scanner.calibRms });
      if (res.keyframe && recordOn) record(msg.buf, msg.w, msg.h, msg.time, res).catch(() => {});
      if (res.keyframe) keysSincePreview++;
      if (scanner.focalN && keysSincePreview > 0 && (keysSincePreview >= 4 || performance.now() - lastPreview > 2500)) sendPreview();
    } else if (msg.type === 'preview') {
      if (scanner) sendPreview();
    } else if (msg.type === 'final') {
      let sc = scanner;
      if (scanner.wantsRefine && recorded.length >= 8 && typeof OffscreenCanvas !== 'undefined') {
        sc = await refine();
        postMessage({ type: 'refined', views: sc.volume.views, before: scanner.stats(), after: sc.stats() });
      }
      const m = sc.finalMesh({ smooth: msg.smooth ?? 6 });
      const placed = placeOnBed(m);
      lastFinal = placed;
      const stl = toSTL(placed, 'fotogiro');
      postMessage({ type: 'final', positions: m.positions, indices: m.indices, normals: m.normals, report: m.report, stl: stl.buffer }, [m.positions.buffer, m.normals.buffer, stl.buffer]);
    } else if (msg.type === 'obj') {
      if (lastFinal) postMessage({ type: 'obj', text: toOBJ(lastFinal) });
    } else if (msg.type === 'export') {
      postMessage({ type: 'export', frames: recorded, focalN: scanner ? scanner.focalN : 0 });
    } else if (msg.type === 'stats') {
      postMessage({ type: 'stats', stats: scanner.stats(), coverage: scanner.coverage.summary() });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err), id: msg.id });
  }
};
