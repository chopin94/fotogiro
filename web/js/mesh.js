// Dalla griglia di voxel alla mesh stampabile.
// Marching tetrahedra (6 tetraedri per cubo, scomposizione di Kuhn): nessun caso
// ambiguo, quindi la superficie è sempre chiusa (watertight) e senza crepe.
// Il campo è circondato da un guscio "fuori" così il solido si chiude anche alla base.

const TETS = [
  [0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7],
];

export function extractSurface(field) {
  const { data, nx, ny, nz, vs, ox, oy, oz } = field;
  // griglia con guscio esterno di 1 cella
  const X = nx + 2, Y = ny + 2, Z = nz + 2;
  const outside = -vs;
  const tiny = 1e-3 * vs;
  const val = (i, j, l) => {
    const a = i - 1, b = j - 1, c = l - 1;
    if (a < 0 || b < 0 || a >= nx || b >= ny || c >= nz) return outside;
    if (c < 0) {
      // sotto la base: valore speculare, così il fondo cade esattamente su z = oz
      const v0 = data[a + nx * b];
      return -Math.abs(v0) - tiny;
    }
    const v = data[a + nx * (b + ny * c)];
    return v === 0 ? -tiny : v;
  };
  const pos = (i, j, l) => [ox + (i - 0.5) * vs, oy + (j - 0.5) * vs, oz + (l - 0.5) * vs];
  const positions = [];
  const indices = [];
  const vmap = new Map();
  const NN = X * Y * Z;
  const corner = new Array(8);
  const cval = new Float64Array(8);
  const cidx = new Float64Array(8);
  const vertexOn = (a, b) => {
    const ka = cidx[a], kb = cidx[b];
    const key = ka < kb ? ka * NN + kb : kb * NN + ka;
    let id = vmap.get(key);
    if (id !== undefined) return id;
    const va = cval[a], vb = cval[b];
    const t = va / (va - vb);
    const pa = corner[a], pb = corner[b];
    id = positions.length / 3;
    // niente sotto il piano d'appoggio: la base resta piatta
    const z = Math.max(oz, pa[2] + (pb[2] - pa[2]) * t);
    positions.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, z);
    vmap.set(key, id);
    return id;
  };
  const emit = (a, b, c, inPt, outPt) => {
    // orienta la normale dall'interno verso l'esterno
    const P = (id) => [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
    const p0 = P(a), p1 = P(b), p2 = P(c);
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const d = [outPt[0] - inPt[0], outPt[1] - inPt[1], outPt[2] - inPt[2]];
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0) indices.push(a, c, b);
    else indices.push(a, b, c);
  };
  const mean = (ids) => {
    const m = [0, 0, 0];
    for (const i of ids) { m[0] += corner[i][0]; m[1] += corner[i][1]; m[2] += corner[i][2]; }
    return m.map((v) => v / ids.length);
  };
  for (let l = 0; l < Z - 1; l++) {
    for (let j = 0; j < Y - 1; j++) {
      for (let i = 0; i < X - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const di = c & 1, dj = (c >> 1) & 1, dl = (c >> 2) & 1;
          cval[c] = val(i + di, j + dj, l + dl);
          if (cval[c] > 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        for (let c = 0; c < 8; c++) {
          const di = c & 1, dj = (c >> 1) & 1, dl = (c >> 2) & 1;
          corner[c] = pos(i + di, j + dj, l + dl);
          cidx[c] = (i + di) + X * ((j + dj) + Y * (l + dl));
        }
        for (const tet of TETS) {
          const ins = tet.filter((c) => cval[c] > 0);
          const outs = tet.filter((c) => cval[c] <= 0);
          if (ins.length === 0 || ins.length === 4) continue;
          const ip = mean(ins), op = mean(outs);
          if (ins.length === 1 || ins.length === 3) {
            const lone = ins.length === 1 ? ins[0] : outs[0];
            const others = ins.length === 1 ? outs : ins;
            const v = others.map((o) => vertexOn(lone, o));
            emit(v[0], v[1], v[2], ip, op);
          } else {
            const [a, b] = ins;
            const [c, d] = outs;
            const ac = vertexOn(a, c), ad = vertexOn(a, d), bd = vertexOn(b, d), bc = vertexOn(b, c);
            emit(ac, ad, bd, ip, op);
            emit(ac, bd, bc, ip, op);
          }
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

// Unisce i vertici coincidenti (capita quando il campo vale ~0 su un nodo)
// e scarta i triangoli degeneri.
export function cleanMesh(mesh, eps = 1e-5) {
  const { positions, indices } = mesh;
  const map = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const out = [];
  const q = 1 / eps;
  for (let i = 0; i < remap.length; i++) {
    const key = `${Math.round(positions[i * 3] * q)},${Math.round(positions[i * 3 + 1] * q)},${Math.round(positions[i * 3 + 2] * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      map.set(key, id);
    }
    remap[i] = id;
  }
  const idx = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: Float32Array.from(out), indices: Uint32Array.from(idx) };
}

// Tiene solo i pezzi grandi (elimina briciole staccate).
export function keepLargestComponents(mesh, minFraction = 0.05) {
  const { positions, indices } = mesh;
  const nv = positions.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]), b = find(indices[t + 1]), c = find(indices[t + 2]);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const count = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const r = find(indices[t]);
    count.set(r, (count.get(r) || 0) + 1);
  }
  let max = 0;
  for (const c of count.values()) max = Math.max(max, c);
  const keep = new Set([...count].filter(([, c]) => c >= max * minFraction).map(([r]) => r));
  const used = new Int32Array(nv).fill(-1);
  const pos = [];
  const idx = [];
  for (let t = 0; t < indices.length; t += 3) {
    if (!keep.has(find(indices[t]))) continue;
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k];
      if (used[v] < 0) { used[v] = pos.length / 3; pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
      idx.push(used[v]);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), components: keep.size };
}

// Lisciatura di Taubin (non restringe il volume come quella laplaciana).
// I vertici sulla base (z minima) restano sul piano per mantenere la base piatta.
export function taubinSmooth(mesh, iterations = 6, lambda = 0.5, mu = -0.53) {
  const { positions, indices } = mesh;
  const nv = positions.length / 3;
  const nbr = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  const adj = nbr.map((s) => Int32Array.from(s));
  let zmin = Infinity;
  for (let i = 0; i < nv; i++) zmin = Math.min(zmin, positions[i * 3 + 2]);
  const p = Float32Array.from(positions);
  const tmp = new Float32Array(p.length);
  const step = (f) => {
    for (let i = 0; i < nv; i++) {
      const a = adj[i];
      if (!a.length) { tmp[i * 3] = p[i * 3]; tmp[i * 3 + 1] = p[i * 3 + 1]; tmp[i * 3 + 2] = p[i * 3 + 2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const j of a) { sx += p[j * 3]; sy += p[j * 3 + 1]; sz += p[j * 3 + 2]; }
      const n = a.length;
      tmp[i * 3] = p[i * 3] + f * (sx / n - p[i * 3]);
      tmp[i * 3 + 1] = p[i * 3 + 1] + f * (sy / n - p[i * 3 + 1]);
      const onBase = p[i * 3 + 2] - zmin < 1e-4;
      tmp[i * 3 + 2] = onBase ? p[i * 3 + 2] : p[i * 3 + 2] + f * (sz / n - p[i * 3 + 2]);
    }
    p.set(tmp);
  };
  for (let k = 0; k < iterations; k++) { step(lambda); step(mu); }
  return { positions: p, indices };
}

export function vertexNormals(mesh) {
  const { positions: p, indices: ix } = mesh;
  const n = new Float32Array(p.length);
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// Controlli per la stampa: ogni spigolo condiviso da esattamente 2 triangoli
// con verso opposto (chiusa e orientata), volume con segno.
export function meshReport(mesh) {
  const { positions: p, indices: ix } = mesh;
  const edges = new Map();
  const nv = p.length / 3;
  let bad = 0;
  for (let t = 0; t < ix.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = ix[t + k], b = ix[t + ((k + 1) % 3)];
      const key = a * nv + b;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const [key, c] of edges) {
    const a = Math.floor(key / nv), b = key % nv;
    const opp = edges.get(b * nv + a) || 0;
    if (c !== 1 || opp !== 1) bad++;
  }
  let vol = 0;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i * 3 + k]);
      max[k] = Math.max(max[k], p[i * 3 + k]);
    }
  }
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return {
    triangles: ix.length / 3,
    vertices: nv,
    watertight: bad === 0,
    badEdges: bad,
    volumeCm3: vol / 1000,
    size: max.map((v, k) => v - min[k]),
    min,
    max,
  };
}

export function toSTL(mesh, name = 'fotogiro') {
  const { positions: p, indices: ix } = mesh;
  const nt = ix.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const header = `${name} - Fotogiro, unita: mm`.slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const v of [n[0] / l, n[1] / l, n[2] / l]) { dv.setFloat32(o, v, true); o += 4; }
    for (const v of [a, b, c]) {
      dv.setFloat32(o, p[v], true); dv.setFloat32(o + 4, p[v + 1], true); dv.setFloat32(o + 8, p[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

export function toOBJ(mesh) {
  const { positions: p, indices: ix } = mesh;
  const lines = ['# Fotogiro - unita: mm'];
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i].toFixed(3)} ${p[i + 1].toFixed(3)} ${p[i + 2].toFixed(3)}`);
  for (let t = 0; t < ix.length; t += 3) lines.push(`f ${ix[t] + 1} ${ix[t + 1] + 1} ${ix[t + 2] + 1}`);
  return lines.join('\n') + '\n';
}

// Sposta la mesh in modo che la base stia su z=0 e il centro su x=y=0.
export function placeOnBed(mesh) {
  const r = meshReport(mesh);
  const cx = (r.min[0] + r.max[0]) / 2, cy = (r.min[1] + r.max[1]) / 2, cz = r.min[2];
  const p = Float32Array.from(mesh.positions);
  for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; p[i + 2] -= cz; }
  return { positions: p, indices: mesh.indices };
}
