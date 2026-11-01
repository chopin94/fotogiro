// Il bersaglio da stampare su A4 e incollare sul piatto.
// Un anello di marker attorno a un'area libera dove si appoggia l'oggetto.
// Coordinate del bersaglio: millimetri, origine al centro, X a destra,
// Y verso l'alto del foglio, Z uscente dal foglio (verso l'oggetto).

import { DICTIONARY, GRID, codeBit } from './dictionary.js';

export const PAGE_W = 210;
export const PAGE_H = 297;
const TOP_MARGIN = 5;
const EDGE_MARGIN = 2;
const CROSS_HALF = 8;
const CROSS_W = 0.4;
const CROSS_VALUE = 0.5; // grigio #808080
const RING_W = 0.3;
const RING_VALUE = 0.69; // grigio #b0b0b0

export const MIN_DIAMETER = 80;
export const MAX_DIAMETER = 200; // il massimo che sta su un A4 con i margini della stampante
export const PLATE_MARGIN = 2; // il bersaglio è un po' più piccolo del piatto

// Diametro del bersaglio adatto a un piatto di `plate` mm (mai più grande del piatto).
export function diameterForPlate(plate, margin = PLATE_MARGIN) {
  return Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, Math.floor(plate - margin)));
}

export function makeBoard({ diameter = 200 } = {}) {
  const D = Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, Math.round(diameter)));
  const R = D / 2;
  const size = Math.round(Math.max(14, Math.min(22, D * 0.11)) * 2) / 2;
  const cell = size / GRID;
  const quiet = cell;
  const half = size / 2;
  // l'angolo esterno del marker deve restare dentro il cerchio con la zona bianca
  const outerMax = R - EDGE_MARGIN - quiet;
  const ringRadius = Math.sqrt(outerMax * outerMax - half * half) - half;
  const inner = ringRadius - half;
  const perMarker = 2 * Math.atan(half / inner) + (1.6 * cell) / inner;
  const count = Math.min(DICTIONARY.length, Math.floor((2 * Math.PI) / perMarker));
  const step = (2 * Math.PI) / count;
  const markers = [];
  for (let k = 0; k < count; k++) {
    const phi = Math.PI / 2 - k * step; // ID 0 in alto, poi in senso orario
    const up = [Math.cos(phi), Math.sin(phi)]; // verso l'esterno
    const right = [Math.sin(phi), -Math.cos(phi)];
    const c = [ringRadius * up[0], ringRadius * up[1]];
    const at = (a, b) => [c[0] + a * right[0] + b * up[0], c[1] + a * right[1] + b * up[1]];
    const corners = [at(-half, half), at(half, half), at(half, -half), at(-half, -half)];
    markers.push({ id: k, code: DICTIONARY[k], phi, center: c, up, right, corners });
  }
  return {
    diameter: D,
    radius: R,
    markerSize: size,
    cell,
    ringRadius,
    count,
    step,
    clearRadius: inner - quiet,
    safeRadius: R - EDGE_MARGIN - 0.5,
    markers,
    byId: new Map(markers.map((m) => [m.id, m])),
  };
}

// Punto del marker in coordinate di griglia (gx a destra, gy in basso, 0..6).
export function markerPoint(m, size, gx, gy) {
  const a = (gx / GRID) * size - size / 2;
  const b = size / 2 - (gy / GRID) * size;
  return [m.center[0] + a * m.right[0] + b * m.up[0], m.center[1] + a * m.right[1] + b * m.up[1]];
}

// Riflettanza ideale del bersaglio in (x, y): 1 bianco, 0 nero, -1 fuori dal foglio.
export function boardValue(board, x, y) {
  const r2 = x * x + y * y;
  const R = board.radius;
  if (r2 > R * R) return -1;
  const r = Math.sqrt(r2);
  const half = board.markerSize / 2;
  if (r > board.ringRadius - half * 1.5 && r < board.ringRadius + half * 1.5) {
    const phi = Math.atan2(y, x);
    const k0 = Math.round((Math.PI / 2 - phi) / board.step);
    for (let dk = -1; dk <= 1; dk++) {
      const m = board.markers[(((k0 + dk) % board.count) + board.count) % board.count];
      const dx = x - m.center[0];
      const dy = y - m.center[1];
      const a = dx * m.right[0] + dy * m.right[1];
      const b = dx * m.up[0] + dy * m.up[1];
      if (a > -half && a < half && b > -half && b < half) {
        const gx = Math.min(GRID - 1, Math.floor(((a + half) / board.markerSize) * GRID));
        const gy = Math.min(GRID - 1, Math.floor(((half - b) / board.markerSize) * GRID));
        if (gx === 0 || gy === 0 || gx === GRID - 1 || gy === GRID - 1) return 0;
        return codeBit(m.code, gy - 1, gx - 1) ? 0 : 1;
      }
    }
  }
  if ((Math.abs(y) < CROSS_W / 2 && Math.abs(x) < CROSS_HALF) || (Math.abs(x) < CROSS_W / 2 && Math.abs(y) < CROSS_HALF)) {
    return CROSS_VALUE;
  }
  if (Math.abs(r - board.clearRadius) < RING_W / 2) return RING_VALUE;
  return 1;
}

// Texture del bersaglio campionata a `ppm` pixel per mm, con antialiasing.
// Restituisce i livelli sfocati usati dal confronto con l'immagine e le maschere
// delle zone sicuramente bianche / nere usate per stimare l'illuminazione.
export function boardTexture(board, { ppm = 2, sigmas = [0.5, 1.0, 2.0], supersample = 4 } = {}) {
  const pad = 4;
  const size = Math.ceil(board.diameter * ppm) + 2 * pad;
  const origin = -(size / 2) / ppm; // coordinata mm del bordo del texel 0
  const base = new Float32Array(size * size);
  const ss = supersample;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let acc = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = origin + (i + (si + 0.5) / ss) / ppm;
          const y = -(origin + (j + (sj + 0.5) / ss) / ppm); // riga 0 = Y massimo
          const v = boardValue(board, x, y);
          acc += v < 0 ? 1 : v;
        }
      }
      base[j * size + i] = acc / (ss * ss);
    }
  }
  const levels = sigmas.map((s) => ({ sigma: s, data: gaussianBlur(base, size, s * ppm) }));
  const rw = Math.max(1, Math.round(1.5 * ppm));
  const rb = Math.max(1, Math.round(0.6 * ppm));
  const minW = minFilter(base, size, rw);
  const maxB = maxFilter(base, size, rb);
  const kind = new Uint8Array(size * size); // 1 bianco puro, 2 nero puro, 0 misto
  for (let i = 0; i < kind.length; i++) {
    if (minW[i] > 0.97) kind[i] = 1;
    else if (maxB[i] < 0.03) kind[i] = 2;
  }
  return { size, ppm, origin, base, levels, kind };
}

// Coordinate texel (continue) del punto (x, y) in mm.
export function texCoord(tex, x, y) {
  return [(x - tex.origin) * tex.ppm - 0.5, (-y - tex.origin) * tex.ppm - 0.5];
}

export function sampleTex(data, size, tx, ty) {
  if (tx < 0) tx = 0; else if (tx > size - 1.001) tx = size - 1.001;
  if (ty < 0) ty = 0; else if (ty > size - 1.001) ty = size - 1.001;
  const x0 = tx | 0;
  const y0 = ty | 0;
  const fx = tx - x0;
  const fy = ty - y0;
  const i = y0 * size + x0;
  const a = data[i] + (data[i + 1] - data[i]) * fx;
  const b = data[i + size] + (data[i + size + 1] - data[i + size]) * fx;
  return a + (b - a) * fy;
}

function gaussianBlur(src, size, sigma) {
  if (sigma < 0.3) return Float32Array.from(src);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(size - 1, Math.max(0, x + i));
        acc += src[y * size + xx] * k[i + r];
      }
      tmp[y * size + x] = acc;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(size - 1, Math.max(0, y + i));
        acc += tmp[yy * size + x] * k[i + r];
      }
      out[y * size + x] = acc;
    }
  }
  return out;
}

function rankFilter(src, size, r, pick) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = src[y * size + x];
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < size) v = pick(v, src[y * size + xx]);
      }
      tmp[y * size + x] = v;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = tmp[y * size + x];
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < size) v = pick(v, tmp[yy * size + x]);
      }
      out[y * size + x] = v;
    }
  }
  return out;
}

const minFilter = (s, n, r) => rankFilter(s, n, r, Math.min);
const maxFilter = (s, n, r) => rankFilter(s, n, r, Math.max);

// ---------------------------------------------------------------------------
// Disegno della pagina A4 (lista di primitive comune a SVG e PDF).
// Coordinate pagina in mm, origine in alto a sinistra, Y verso il basso.

function pageLayout(board) {
  const cx = PAGE_W / 2;
  const cy = TOP_MARGIN + board.radius;
  const toPage = ([x, y]) => [cx + x, cy - y];
  const items = [];
  // taglio
  items.push({ type: 'circle', cx, cy, r: board.radius, stroke: 0.55, width: 0.3, dash: [2, 1.5] });
  // marker: quadrato nero, poi celle bianche leggermente maggiorate (niente fessure)
  const e = 0.02;
  for (const m of board.markers) {
    items.push({ type: 'poly', fill: 0, pts: m.corners.map(toPage) });
    for (let r = 0; r < GRID - 2; r++) {
      for (let c = 0; c < GRID - 2; c++) {
        if (codeBit(m.code, r, c)) continue;
        const g = [
          [c + 1 - e, r + 1 - e], [c + 2 + e, r + 1 - e], [c + 2 + e, r + 2 + e], [c + 1 - e, r + 2 + e],
        ];
        items.push({ type: 'poly', fill: 1, pts: g.map(([gx, gy]) => toPage(markerPoint(m, board.markerSize, gx, gy))) });
      }
    }
  }
  // croce centrale e cerchio dell'area libera
  items.push({ type: 'poly', fill: CROSS_VALUE, pts: [[-CROSS_HALF, CROSS_W / 2], [CROSS_HALF, CROSS_W / 2], [CROSS_HALF, -CROSS_W / 2], [-CROSS_HALF, -CROSS_W / 2]].map(toPage) });
  items.push({ type: 'poly', fill: CROSS_VALUE, pts: [[-CROSS_W / 2, CROSS_HALF], [CROSS_W / 2, CROSS_HALF], [CROSS_W / 2, CROSS_W / 2], [-CROSS_W / 2, CROSS_W / 2]].map(toPage) });
  items.push({ type: 'poly', fill: CROSS_VALUE, pts: [[-CROSS_W / 2, -CROSS_W / 2], [CROSS_W / 2, -CROSS_W / 2], [CROSS_W / 2, -CROSS_HALF], [-CROSS_W / 2, -CROSS_HALF]].map(toPage) });
  items.push({ type: 'circle', cx, cy, r: board.clearRadius, stroke: RING_VALUE, width: RING_W });

  // parte da ritagliare via: istruzioni e righello di controllo
  let y = cy + board.radius + 9;
  const x0 = 15;
  items.push({ type: 'text', x: x0, y, size: 5, bold: true, text: `Fotogiro – bersaglio Ø ${board.diameter} mm` });
  y += 6;
  items.push({ type: 'text', x: x0, y, size: 3.2, text: `${board.count} marker · area libera Ø ${Math.floor(board.clearRadius * 2)} mm · nell'app imposta "Diametro bersaglio" = ${board.diameter} mm` });
  y += 8;
  // righello 100 mm
  items.push({ type: 'line', x1: x0, y1: y, x2: x0 + 100, y2: y, stroke: 0, width: 0.35 });
  for (let i = 0; i <= 100; i += 5) {
    const h = i % 10 === 0 ? 4 : 2;
    items.push({ type: 'line', x1: x0 + i, y1: y, x2: x0 + i, y2: y - h, stroke: 0, width: 0.25 });
    if (i % 50 === 0) items.push({ type: 'text', x: x0 + i - (i ? 2.5 : 0.8), y: y + 4, size: 2.8, text: `${i / 10} cm` });
  }
  items.push({ type: 'text', x: x0 + 113, y: y - 1, size: 3, text: 'Controllo: questa riga deve misurare' });
  items.push({ type: 'text', x: x0 + 113, y: y + 3, size: 3, text: 'esattamente 10 cm (stampa al 100%).' });
  y += 12;
  const steps = [
    '1. Stampa al 100% / "Dimensioni effettive" (mai "Adatta alla pagina"), carta opaca.',
    '2. Ritaglia lungo il cerchio tratteggiato e incollalo ben piatto e centrato sul piatto.',
    '3. Appoggia l’oggetto dentro il cerchio grigio, senza coprire i marker se possibile.',
    '4. Durante la scansione non toccare né spostare l’oggetto rispetto al foglio.',
  ];
  for (const s of steps) { items.push({ type: 'text', x: x0, y, size: 3.2, text: s }); y += 5; }
  return items;
}

const grey = (v) => {
  const h = Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};
const f2 = (v) => (Math.round(v * 1000) / 1000).toString();

export function boardSVG(board) {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}mm" height="${PAGE_H}mm" viewBox="0 0 ${PAGE_W} ${PAGE_H}">`);
  parts.push(`<rect width="${PAGE_W}" height="${PAGE_H}" fill="#fff"/>`);
  for (const it of pageLayout(board)) {
    if (it.type === 'poly') {
      parts.push(`<polygon fill="${grey(it.fill)}" points="${it.pts.map((p) => `${f2(p[0])},${f2(p[1])}`).join(' ')}"/>`);
    } else if (it.type === 'circle') {
      const dash = it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : '';
      parts.push(`<circle cx="${f2(it.cx)}" cy="${f2(it.cy)}" r="${f2(it.r)}" fill="none" stroke="${grey(it.stroke)}" stroke-width="${it.width}"${dash}/>`);
    } else if (it.type === 'line') {
      parts.push(`<line x1="${f2(it.x1)}" y1="${f2(it.y1)}" x2="${f2(it.x2)}" y2="${f2(it.y2)}" stroke="${grey(it.stroke)}" stroke-width="${it.width}"/>`);
    } else if (it.type === 'text') {
      const esc = it.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      parts.push(`<text x="${f2(it.x)}" y="${f2(it.y)}" font-family="Helvetica, Arial, sans-serif" font-size="${it.size}"${it.bold ? ' font-weight="bold"' : ''} fill="#000">${esc}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// PDF vettoriale minimale (una pagina A4, font Helvetica standard).
export function boardPDF(board) {
  const k = 72 / 25.4;
  const ops = [`${f2(k)} 0 0 ${f2(-k)} 0 ${f2(PAGE_H * k)} cm`];
  const kappa = 0.5522847498;
  for (const it of pageLayout(board)) {
    if (it.type === 'poly') {
      ops.push(`${f2(it.fill)} g`);
      ops.push(it.pts.map((p, i) => `${f2(p[0])} ${f2(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h f');
    } else if (it.type === 'circle') {
      const { cx, cy, r } = it;
      const c = r * kappa;
      ops.push(`${f2(it.stroke)} G ${f2(it.width)} w ${it.dash ? `[${it.dash.join(' ')}] 0 d` : '[] 0 d'}`);
      ops.push(
        `${f2(cx + r)} ${f2(cy)} m ` +
          `${f2(cx + r)} ${f2(cy + c)} ${f2(cx + c)} ${f2(cy + r)} ${f2(cx)} ${f2(cy + r)} c ` +
          `${f2(cx - c)} ${f2(cy + r)} ${f2(cx - r)} ${f2(cy + c)} ${f2(cx - r)} ${f2(cy)} c ` +
          `${f2(cx - r)} ${f2(cy - c)} ${f2(cx - c)} ${f2(cy - r)} ${f2(cx)} ${f2(cy - r)} c ` +
          `${f2(cx + c)} ${f2(cy - r)} ${f2(cx + r)} ${f2(cy - c)} ${f2(cx + r)} ${f2(cy)} c S`,
      );
    } else if (it.type === 'line') {
      ops.push(`${f2(it.stroke)} G ${f2(it.width)} w [] 0 d ${f2(it.x1)} ${f2(it.y1)} m ${f2(it.x2)} ${f2(it.y2)} l S`);
    } else if (it.type === 'text') {
      ops.push(`0 g BT /${it.bold ? 'F2' : 'F1'} ${f2(it.size)} Tf 1 0 0 -1 ${f2(it.x)} ${f2(it.y)} Tm (${pdfText(it.text)}) Tj ET`);
    }
  }
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(PAGE_W * k)} ${f2(PAGE_H * k)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

const WIN_ANSI_EXTRA = { 0x2013: 150, 0x2014: 151, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x20ac: 128 };

function pdfText(s) {
  let out = '';
  for (const ch of s) {
    const u = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (u >= 32 && u < 127) out += ch;
    else {
      const code = u >= 160 && u <= 255 ? u : WIN_ANSI_EXTRA[u] || 63;
      out += '\\' + code.toString(8).padStart(3, '0');
    }
  }
  return out;
}
