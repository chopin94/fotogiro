// Dizionario dei marker: griglia 6x6 celle con bordo nero e 4x4 bit interni.
// Il dizionario è generato in modo deterministico (stesso risultato su ogni
// dispositivo), quindi il foglio stampato e il riconoscitore coincidono sempre.
//
// Convenzione: bit (r*4 + c), riga r dall'alto, colonna c da sinistra,
// 1 = cella nera (inchiostro), 0 = cella bianca.

export const BITS = 4;
export const GRID = BITS + 2; // celle per lato, bordo compreso
export const MIN_DISTANCE = 5; // distanza di Hamming minima, rotazioni comprese
export const MAX_CORRECTION = 1; // bit errati tollerati in lettura

// Ruota il codice di 90° in senso orario: nuovo[r][c] = vecchio[3-c][r].
export function rotateCode(code) {
  let out = 0;
  for (let r = 0; r < BITS; r++) {
    for (let c = 0; c < BITS; c++) {
      if ((code >> ((BITS - 1 - c) * BITS + r)) & 1) out |= 1 << (r * BITS + c);
    }
  }
  return out;
}

export function rotations(code) {
  const out = [code];
  for (let i = 0; i < 3; i++) out.push(rotateCode(out[i]));
  return out;
}

export function hamming(a, b) {
  let x = (a ^ b) >>> 0;
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDictionary(count = 64, seed = 20261101) {
  const n = 1 << (BITS * BITS);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const rnd = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const accepted = [];
  for (let k = 0; k < n && accepted.length < count; k++) {
    const code = order[k];
    const ones = hamming(code, 0);
    if (ones < 5 || ones > 11) continue; // né troppo bianco né troppo nero
    const rs = rotations(code);
    // deve essere riconoscibile anche la sua rotazione
    if (Math.min(hamming(code, rs[1]), hamming(code, rs[2]), hamming(code, rs[3])) < MIN_DISTANCE) continue;
    let ok = true;
    for (const a of accepted) {
      for (const r of rs) {
        if (hamming(a, r) < MIN_DISTANCE) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) accepted.push(code);
  }
  return accepted;
}

export const DICTIONARY = generateDictionary();

// Cerca il codice letto (già nell'orientamento giusto) nel dizionario.
export function matchCode(code, maxErr = MAX_CORRECTION) {
  let best = -1;
  let bestD = maxErr + 1;
  for (let i = 0; i < DICTIONARY.length; i++) {
    const d = hamming(code, DICTIONARY[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best < 0 ? null : { id: best, dist: bestD };
}

export function codeBit(code, r, c) {
  return (code >> (r * BITS + c)) & 1;
}
