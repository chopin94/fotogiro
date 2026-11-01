// Il caso reale più difficile: telefono in mano che gira intorno, stanza piena
// di oggetti colorati (anche degli stessi colori della statuina).

import { test, assert } from './harness.mjs';
import { makeBoard } from '../web/js/board.js';
import { Scanner } from '../web/js/scanner.js';
import { makeScene, orbitCamera, renderPose, insideObject, DEMO_OBJECT } from '../web/js/sim.js';

const board = makeBoard({ diameter: 200 });

export function handheldPath() {
  const path = [];
  for (const el of [25, 45, 65]) {
    for (let a = 0; a < 360; a += 15) {
      path.push({
        el: el + 4 * Math.sin(a * 0.05),
        a: a + el,
        d: 360 + 30 * Math.sin(a * 0.03 + el),
        roll: 6 * Math.sin(a * 0.07),
        offset: [6 * Math.sin(a), 6 * Math.cos(a * 1.3)],
      });
    }
  }
  return path;
}

export function scoreField(field) {
  let tp = 0, fn = 0, fp = 0;
  for (let z = 1; z < 110; z += 3) for (let y = -60; y < 60; y += 3) for (let x = -60; x < 60; x += 3) {
    const a = insideObject(DEMO_OBJECT, x, y, z);
    const i = Math.floor((x - field.ox) / field.vs), j = Math.floor((y - field.oy) / field.vs), l = Math.floor(z / field.vs);
    const b = i >= 0 && j >= 0 && l >= 0 && i < field.nx && j < field.ny && l < field.nz && field.data[i + field.nx * (j + field.ny * l)] > 0;
    if (a && b) tp++; else if (a) fn++; else if (b) fp++;
  }
  return { iou: tp / (tp + fn + fp), lost: fn / (tp + fn), extra: fp / (tp + fn) };
}

// `scanner`: per il secondo passaggio si passa first.refined()
export function runHandheld(settings = {}, { scanner = null } = {}) {
  const scene = makeScene(board, { clutter: true });
  const sc = scanner || new Scanner({ boardDiameter: 200, voxel: 1.5, volHeight: 110, ...settings });
  let time = 0;
  for (const p of handheldPath()) {
    const cam = orbitCamera({ azimuth: p.a, elevation: p.el, distance: p.d, roll: p.roll, offset: p.offset });
    const rgba = renderPose(scene, cam.K, cam.R, cam.t, cam.w, cam.h, { seed: Math.round(p.a * 7 + p.el) });
    sc.processFrame(rgba, cam.w, cam.h, time, { force: true });
    time += 1;
  }
  return sc;
}

test('telefono in mano in una stanza disordinata: la statuina non viene scavata', () => {
  const first = runHandheld();
  assert.close(first.focalN, 0.8, 0.02, 'focale calibrata');
  const s1 = scoreField(first.volume.field());
  // la parte dell'oggetto persa è l'errore grave: deve restare piccolissima
  // (prima della correzione era il 34%)
  assert.atMost(s1.lost, 0.07, 'oggetto scavato via (1° passaggio)');
  assert.atLeast(s1.iou, 0.75, 'IoU (1° passaggio)');
  // l'ombra, ferma rispetto al foglio, non deve diventare un'ala del solido
  const st1 = first.volume.stats();
  assert.atMost(Math.max(st1.size[0], st1.size[1]), 68, 'larghezza senza ombra (mm)');

  // secondo passaggio, come fa "Genera modello": toglie lo spazio sopra la testa
  assert.ok(first.wantsRefine, 'il secondo passaggio deve partire');
  const second = runHandheld({}, { scanner: first.refined() });
  const s2 = scoreField(second.volume.field());
  assert.atMost(s2.lost, 0.07, 'oggetto scavato via (2° passaggio)');
  assert.atLeast(s2.iou, 0.8, 'IoU (2° passaggio)');
  const mesh = second.finalMesh({ smooth: 4 });
  assert.ok(mesh.report.watertight, 'mesh chiusa');
  assert.close(mesh.report.size[2], 94, 4, 'altezza (mm)');
  assert.atMost(Math.max(mesh.report.size[0], mesh.report.size[1]), 68, 'larghezza (mm)');
});
