// Disegna i fotogrammi della demo (scena sintetica) senza bloccare l'interfaccia.

import { makeBoard } from './board.js';
import { makeScene, fixedCamera, renderView } from './sim.js';

let scene = null;

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    scene = makeScene(makeBoard({ diameter: m.diameter }));
    postMessage({ type: 'ready' });
  } else if (m.type === 'render') {
    const cam = fixedCamera({ w: m.w, h: m.h, elevation: m.elevation, distance: m.distance || 380 });
    const rgba = renderView(scene, cam, m.angle, { seed: m.seed || 1 });
    postMessage({ type: 'frame', buf: rgba.buffer, w: m.w, h: m.h, elevation: m.elevation, angle: m.angle }, [rgba.buffer]);
  }
};
