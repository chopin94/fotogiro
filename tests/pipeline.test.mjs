// Test completi su immagini sintetiche: il bersaglio stampato, un oggetto di
// forma nota, sfondo e ombre, ripresi da un telefono fermo con il piatto che gira.

import { test, assert } from './harness.mjs';
import { makeBoard } from '../web/js/board.js';
import { MarkerDetector, rgbaToGray } from '../web/js/markers.js';
import { project, rotationAngleBetween, scaleK } from '../web/js/geometry.js';
import { VoxelVolume } from '../web/js/carve.js';
import { signedDistance, Segmenter } from '../web/js/segment.js';
import { Scanner } from '../web/js/scanner.js';
import { meshReport } from '../web/js/mesh.js';
import { makeScene, fixedCamera, poseAt, renderView, insideObject, hitParts, DEMO_OBJECT } from '../web/js/sim.js';

const board = makeBoard({ diameter: 200 });
const scene = makeScene(board);

function objectMask(cam, pose, w, h, K) {
  // maschera ideale: raggio per pixel contro la forma analitica (campionamento lungo il raggio)
  const m = new Uint8Array(w * h);
  const R = pose.R, t = pose.t;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const dc = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1];
      const d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
      const L = Math.hypot(...d);
      if (hitParts(DEMO_OBJECT, C, [d[0] / L, d[1] / L, d[2] / L], Infinity)) m[v * w + u] = 1;
    }
  }
  return m;
}

function iou(fieldFn, step = 2) {
  let inter = 0, uni = 0;
  for (let z = 1; z < 110; z += step) for (let y = -60; y < 60; y += step) for (let x = -60; x < 60; x += step) {
    const a = insideObject(DEMO_OBJECT, x, y, z);
    const b = fieldFn(x, y, z);
    if (a && b) inter++;
    if (a || b) uni++;
  }
  return inter / uni;
}

function volumeLookup(field) {
  return (x, y, z) => {
    const i = Math.floor((x - field.ox) / field.vs), j = Math.floor((y - field.oy) / field.vs), l = Math.floor(z / field.vs);
    if (i < 0 || j < 0 || l < 0 || i >= field.nx || j >= field.ny || l >= field.nz) return false;
    return field.data[i + field.nx * (j + field.ny * l)] > 0;
  };
}

test('marker: riconosciuti con angoli precisi su immagini sintetiche', () => {
  const det = new MarkerDetector();
  for (const [el, ang] of [[30, 0], [45, 37], [20, 200]]) {
    const cam = fixedCamera({ w: 960, h: 540, elevation: el, distance: 380 });
    const pose = poseAt(cam, ang);
    const rgba = renderView(scene, cam, ang);
    const found = det.detect(rgbaToGray(rgba, 960, 540), 960, 540);
    assert.atLeast(found.length, 6, `marker trovati (elev ${el}°)`);
    let worst = 0;
    for (const m of found) {
      const bm = board.byId.get(m.id);
      assert.ok(bm, 'id valido');
      for (let c = 0; c < 4; c++) {
        const p = project(cam.K, pose.R, pose.t, [bm.corners[c][0], bm.corners[c][1], 0]);
        worst = Math.max(worst, Math.hypot(p[0] - m.corners[c][0], p[1] - m.corners[c][1]));
      }
    }
    // il render sintetico non ha antialiasing: a 20° i bordi sono molto scalettati
    assert.atMost(worst, el < 25 ? 2.0 : 1.5, `errore angoli (px, elev ${el}°)`);
  }
});

test('scultura con silhouette ideali: forma giusta', () => {
  const vol = new VoxelVolume({ radius: 60, height: 110, voxel: 1.5, k: 1 });
  const w = 320, h = 180;
  for (const el of [15, 40, 65]) {
    const cam = fixedCamera({ w, h, elevation: el, distance: 380 });
    for (let a = 0; a < 360; a += 20) {
      const pose = poseAt(cam, a);
      const mask = objectMask(cam, pose, w, h, cam.K);
      vol.integrate(signedDistance(mask, w, h), w, h, cam.K, pose.R, pose.t);
    }
  }
  const field = vol.field();
  const score = iou(volumeLookup(field), 3);
  assert.atLeast(score, 0.85, 'IoU con la forma vera');
});

test('silhouette sintetica: coincide con la maschera ideale', () => {
  const seg = new Segmenter(board);
  const cam = fixedCamera({ w: 960, h: 540, elevation: 30, distance: 380 });
  const pose = poseAt(cam, 60);
  const rgba = renderView(scene, cam, 60);
  // ridotta a 480x270 come nell'app
  const small = new Uint8ClampedArray(480 * 270 * 4);
  for (let y = 0; y < 270; y++) for (let x = 0; x < 480; x++) for (let c = 0; c < 4; c++) {
    const a = ((2 * y) * 960 + 2 * x) * 4 + c;
    small[(y * 480 + x) * 4 + c] = (rgba[a] + rgba[a + 4] + rgba[a + 960 * 4] + rgba[a + 960 * 4 + 4]) / 4;
  }
  const K = scaleK(cam.K, 2);
  const res = seg.segment(small, 480, 270, K, pose.R, pose.t, { radius: 66, height: 120 });
  const truth = objectMask(cam, pose, 480, 270, K);
  let fn = 0, fp = 0, pos = 0;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i]) { pos++; if (!res.mask[i]) fn++; } else if (res.mask[i]) fp++;
  }
  assert.atMost(fn / pos, 0.03, 'pixel di oggetto persi');
  assert.atMost(fp / pos, 0.15, 'pixel di sfondo presi per oggetto');
});

test('pipeline completa: da video sintetico a solido stampabile', () => {
  const sc = new Scanner({ boardDiameter: 200, voxel: 1.5, volHeight: 110 });
  let time = 0;
  const w = 960, h = 540;
  let keys = 0;
  for (const el of [22, 45]) {
    const cam = fixedCamera({ w, h, elevation: el, distance: 380 });
    for (let a = 0; a < 360; a += 12) {
      const rgba = renderView(scene, cam, a, { seed: a + el });
      const r = sc.processFrame(rgba, w, h, time, { force: true });
      time += 1;
      if (r.keyframe) keys++;
      if (r.ok && sc.focalN) {
        const truth = poseAt(cam, a);
        assert.atMost(rotationAngleBetween(r.R, truth.R), 1.0, 'errore di posa');
      }
    }
  }
  assert.atLeast(keys, 50, 'fotogrammi chiave');
  assert.close(sc.focalN, 0.8, 0.02, 'focale calibrata');
  const mesh = sc.finalMesh({ smooth: 4 });
  const rep = mesh.report;
  assert.ok(rep.watertight, `mesh chiusa (${rep.badEdges} spigoli aperti)`);
  assert.close(rep.size[2], 94, 5, 'altezza (mm)');
  const field = sc.volume.field();
  assert.atLeast(iou(volumeLookup(field), 3), 0.75, 'IoU con la forma vera');
});
