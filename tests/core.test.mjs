import { test, assert } from './harness.mjs';
import { DICTIONARY, rotations, hamming, rotateCode, MIN_DISTANCE } from '../web/js/dictionary.js';
import { makeBoard, boardValue, boardSVG, boardPDF, diameterForPlate } from '../web/js/board.js';
import {
  homography, applyH, poseFromHomography, refinePose, project, rodrigues, mat3mul,
  focalFromHomographies, refineFocal, rotationAngleBetween,
} from '../web/js/geometry.js';
import { extractSurface, meshReport, toSTL, taubinSmooth } from '../web/js/mesh.js';
import { fixedCamera, poseAt } from '../web/js/sim.js';

test('dizionario: abbastanza marker e ben distinti anche ruotati', () => {
  assert.atLeast(DICTIONARY.length, 20, 'marker nel dizionario');
  for (const c of DICTIONARY) {
    assert.equal(rotateCode(rotateCode(rotateCode(rotateCode(c)))), c, 'quattro rotazioni = identità');
    const r = rotations(c);
    for (let k = 1; k < 4; k++) assert.atLeast(hamming(c, r[k]), MIN_DISTANCE, 'auto-distanza');
  }
  for (let i = 0; i < DICTIONARY.length; i++) {
    for (let j = i + 1; j < DICTIONARY.length; j++) {
      for (const r of rotations(DICTIONARY[j])) assert.atLeast(hamming(DICTIONARY[i], r), MIN_DISTANCE, 'distanza tra marker');
    }
  }
});

test('bersaglio: layout dentro il foglio e marker non sovrapposti', () => {
  for (const D of [200, 150, 120]) {
    const b = makeBoard({ diameter: D });
    assert.atLeast(b.count, 12, `marker per Ø${D}`);
    assert.atLeast(b.clearRadius, D * 0.3, 'area libera');
    for (const m of b.markers) {
      for (const c of m.corners) assert.atMost(Math.hypot(c[0], c[1]), b.radius - 2, 'angolo dentro il cerchio');
    }
    // il bordo del marker è nero, il centro del bersaglio bianco
    const m0 = b.markers[0];
    const e = 0.2;
    const tl = m0.corners[0];
    assert.equal(boardValue(b, tl[0] + e * (m0.right[0] - m0.up[0]), tl[1] + e * (m0.right[1] - m0.up[1])), 0, 'angolo nero');
    assert.equal(boardValue(b, 20, 20), 1, 'area libera bianca');
    assert.equal(boardValue(b, b.radius + 1, 0), -1, 'fuori dal foglio');
  }
});

test('bersaglio: diametro libero, mai più grande del piatto', () => {
  assert.equal(diameterForPlate(190), 188, 'piatto 190 -> bersaglio 188');
  assert.equal(diameterForPlate(183.5), 181, 'arrotonda per difetto');
  assert.equal(diameterForPlate(260), 200, 'massimo A4');
  for (const D of [188, 173, 80]) {
    const b = makeBoard({ diameter: D });
    assert.equal(b.diameter, D, 'diametro esatto');
    assert.atLeast(b.count, 6, `marker per Ø${D}`);
    for (const m of b.markers) for (const c of m.corners) assert.atMost(Math.hypot(c[0], c[1]), b.radius - 2, 'angolo dentro il cerchio');
    // marker vicini non si toccano
    for (let i = 0; i < b.count; i++) {
      const a = b.markers[i], n = b.markers[(i + 1) % b.count];
      let dmin = Infinity;
      for (const p of a.corners) for (const q of n.corners) dmin = Math.min(dmin, Math.hypot(p[0] - q[0], p[1] - q[1]));
      assert.atLeast(dmin, b.cell * 1.5, 'spazio bianco tra marker');
    }
  }
});

test('bersaglio: SVG e PDF ben formati', () => {
  const b = makeBoard({ diameter: 200 });
  const svg = boardSVG(b);
  assert.ok(svg.startsWith('<svg') && svg.includes('210mm') && svg.endsWith('</svg>'), 'svg');
  const pdf = boardPDF(b);
  const all = new TextDecoder('latin1').decode(pdf);
  assert.equal(all.length, pdf.length, 'un carattere per byte');
  assert.ok(all.startsWith('%PDF-1.4'), 'intestazione pdf');
  assert.ok(all.trimEnd().endsWith('%%EOF'), 'fine pdf');
  // la tabella xref punta davvero agli oggetti
  const start = Number(all.match(/startxref\n(\d+)/)[1]);
  assert.ok(all.slice(start).startsWith('xref'), 'startxref');
  const offs = [...all.slice(start).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offs.forEach((o, i) => assert.ok(all.slice(o).startsWith(`${i + 1} 0 obj`), `offset oggetto ${i + 1}`));
});

test('omografia: ritrova la trasformazione', () => {
  const H = [1.2, 0.1, 30, -0.05, 0.9, 12, 0.0004, -0.0002, 1];
  const src = [[-50, -40], [60, -30], [55, 70], [-45, 65], [0, 0], [10, -20]];
  const dst = src.map((p) => applyH(H, p[0], p[1]));
  const E = homography(src, dst);
  for (const p of [[5, 5], [-30, 40], [70, -10]]) {
    const a = applyH(H, p[0], p[1]);
    const b = applyH(E, p[0], p[1]);
    assert.close(Math.hypot(a[0] - b[0], a[1] - b[1]), 0, 1e-6, 'errore');
  }
});

test('posa: ricostruita dai punti del bersaglio con rumore', () => {
  const b = makeBoard({ diameter: 200 });
  const cam = fixedCamera({ elevation: 35, distance: 380 });
  const truth = poseAt(cam, 40);
  const obj = [];
  for (const m of b.markers.slice(0, 7)) for (const c of m.corners) obj.push([c[0], c[1], 0]);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const img = obj.map((X) => { const p = project(cam.K, truth.R, truth.t, X); return [p[0] + rnd() * 0.6, p[1] + rnd() * 0.6]; });
  const H = homography(obj.map((p) => [p[0], p[1]]), img);
  const p0 = poseFromHomography(H, cam.K);
  const p = refinePose(cam.K, p0.R, p0.t, obj, img);
  assert.atMost(rotationAngleBetween(p.R, truth.R), 0.3, 'errore di rotazione (gradi)');
  assert.atMost(Math.hypot(p.t[0] - truth.t[0], p.t[1] - truth.t[1], p.t[2] - truth.t[2]), 3, 'errore di traslazione (mm)');
  assert.atMost(p.rms, 0.5, 'rms');
});

test('focale: stimata da un giro del piatto', () => {
  const b = makeBoard({ diameter: 200 });
  const cam = fixedCamera({ elevation: 30, distance: 360, focal: 0.83 });
  const views = [];
  for (let a = 0; a < 360; a += 30) {
    const P = poseAt(cam, a);
    const obj = [], img = [];
    for (const m of b.markers) {
      for (const c of m.corners) {
        const X = [c[0], c[1], 0];
        const p = project(cam.K, P.R, P.t, X);
        obj.push(X); img.push([p[0], p[1]]);
      }
    }
    views.push({ H: homography(obj.map((p) => [p[0], p[1]]), img), obj, img });
  }
  const est = focalFromHomographies(views.map((v) => v.H), cam.K.cx, cam.K.cy, 960);
  assert.close(est.f / cam.K.fx, 1, 0.02, 'focale lineare');
  const ref = refineFocal(views, est.f, cam.K.cx, cam.K.cy);
  assert.close(ref.f / cam.K.fx, 1, 0.005, 'focale rifinita');
});

test('mesh: sfera chiusa, volume corretto, STL coerente', () => {
  const n = 40, vs = 1, r = 15;
  const data = new Float32Array(n * n * n);
  for (let l = 0; l < n; l++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = i + 0.5 - n / 2, y = j + 0.5 - n / 2, z = l + 0.5 - n / 2;
    data[i + n * (j + n * l)] = r - Math.hypot(x, y, z);
  }
  let mesh = extractSurface({ data, nx: n, ny: n, nz: n, vs, ox: -n / 2, oy: -n / 2, oz: -n / 2 });
  let rep = meshReport(mesh);
  assert.ok(rep.watertight, `chiusa (${rep.badEdges} spigoli aperti)`);
  const V = (4 / 3) * Math.PI * r ** 3 / 1000;
  assert.close(rep.volumeCm3, V, V * 0.03, 'volume');
  mesh = taubinSmooth(mesh, 4);
  rep = meshReport(mesh);
  assert.ok(rep.watertight, 'chiusa dopo la lisciatura');
  assert.close(rep.volumeCm3, V, V * 0.04, 'volume dopo lisciatura');
  const stl = toSTL(mesh);
  assert.equal(stl.length, 84 + 50 * rep.triangles, 'dimensione STL');
});

test('mesh: oggetto appoggiato ha la base piatta a z=0', () => {
  const n = 30;
  const data = new Float32Array(n * n * n);
  for (let l = 0; l < n; l++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = i + 0.5 - n / 2, y = j + 0.5 - n / 2, z = l + 0.5;
    data[i + n * (j + n * l)] = Math.min(10 - Math.hypot(x, y), 20 - z);
  }
  const mesh = extractSurface({ data, nx: n, ny: n, nz: n, vs: 1, ox: -n / 2, oy: -n / 2, oz: 0 });
  const rep = meshReport(mesh);
  assert.ok(rep.watertight, 'chiusa');
  assert.close(rep.min[2], 0, 1e-3, 'base a z=0');
  let onBase = 0;
  for (let i = 2; i < mesh.positions.length; i += 3) if (Math.abs(mesh.positions[i]) < 1e-3) onBase++;
  assert.atLeast(onBase, 100, 'vertici sulla base');
  assert.close(rep.size[2], 20, 0.6, 'altezza cilindro');
});

test('rotazioni: rodrigues e composizione', () => {
  const R = mat3mul(rodrigues([0.1, -0.2, 0.3]), rodrigues([-0.1, 0.2, -0.3]));
  assert.close(R[0] + R[4] + R[8], 3, 0.05, 'quasi identità');
});
