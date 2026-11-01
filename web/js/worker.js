// Worker: tutta l'elaborazione pesante fuori dal thread dell'interfaccia.

import { Scanner } from './scanner.js';
import { toSTL, toOBJ, placeOnBed } from './mesh.js';

let scanner = null;
let lastPreview = 0;
let keysSincePreview = 0;
let lastFinal = null;

function sendPreview() {
  const m = scanner.previewMesh();
  const stats = scanner.stats();
  postMessage({ type: 'mesh', positions: m.positions, indices: m.indices, normals: m.normals, stats }, [m.positions.buffer, m.indices.buffer, m.normals.buffer]);
  lastPreview = performance.now();
  keysSincePreview = 0;
}

onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      scanner = new Scanner(msg.settings);
      postMessage({ type: 'ready', board: { diameter: scanner.board.diameter, radius: scanner.board.radius, clearRadius: scanner.board.clearRadius, count: scanner.board.count }, volume: scanner.volumeSpec, focalN: scanner.focalN });
    } else if (msg.type === 'frame') {
      const wasCalibrated = !!scanner.focalN;
      const res = scanner.processFrame(new Uint8ClampedArray(msg.buf), msg.w, msg.h, msg.time, { force: msg.force });
      const out = { type: 'frame', id: msg.id, res: { ...res, mask: undefined } };
      const transfer = [];
      if (res.mask) { out.mask = res.mask; out.maskW = res.maskW; out.maskH = res.maskH; transfer.push(res.mask.buffer); }
      postMessage(out, transfer);
      if (!wasCalibrated && scanner.focalN) postMessage({ type: 'focal', focalN: scanner.focalN, rms: scanner.calibRms });
      if (res.keyframe) keysSincePreview++;
      if (scanner.focalN && keysSincePreview > 0 && (keysSincePreview >= 4 || performance.now() - lastPreview > 2500)) sendPreview();
    } else if (msg.type === 'preview') {
      if (scanner) sendPreview();
    } else if (msg.type === 'final') {
      const m = scanner.finalMesh({ smooth: msg.smooth ?? 6 });
      const placed = placeOnBed(m);
      lastFinal = placed;
      const stl = toSTL(placed, 'fotogiro');
      postMessage({ type: 'final', positions: m.positions, indices: m.indices, normals: m.normals, report: m.report, stl: stl.buffer }, [m.positions.buffer, m.normals.buffer, stl.buffer]);
    } else if (msg.type === 'obj') {
      if (lastFinal) postMessage({ type: 'obj', text: toOBJ(lastFinal) });
    } else if (msg.type === 'stats') {
      postMessage({ type: 'stats', stats: scanner.stats(), coverage: scanner.coverage.summary() });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err), id: msg.id });
  }
};
