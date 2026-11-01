// Copertura delle viste: quali angolazioni (azimut x elevazione) sono già state
// riprese, e cosa conviene fare dopo.

export const BANDS = [
  { min: -5, max: 20, label: 'basso' },
  { min: 20, max: 35, label: 'medio-basso' },
  { min: 35, max: 50, label: 'medio' },
  { min: 50, max: 65, label: 'alto' },
  { min: 65, max: 91, label: 'dall’alto' },
];
export const AZ_BINS = 36;

export function bandOf(el) {
  for (let i = 0; i < BANDS.length; i++) if (el >= BANDS[i].min && el < BANDS[i].max) return i;
  return el < BANDS[0].min ? 0 : BANDS.length - 1;
}

export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export class Coverage {
  constructor() {
    this.views = [];
    this.grid = Array.from({ length: BANDS.length }, () => new Uint16Array(AZ_BINS));
  }

  needs(az, el, azStep = 5, elTol = 8) {
    for (const v of this.views) {
      if (Math.abs(v.el - el) < elTol && angleDiff(v.az, az) < azStep * 0.8) return false;
    }
    return true;
  }

  add(az, el, extra = {}) {
    this.views.push({ az, el, ...extra });
    const b = bandOf(el);
    this.grid[b][Math.floor((((az % 360) + 360) % 360) / (360 / AZ_BINS)) % AZ_BINS]++;
  }

  bandFraction(b) {
    let n = 0;
    for (const c of this.grid[b]) if (c) n++;
    return n / AZ_BINS;
  }

  summary() {
    return {
      grid: this.grid.map((g) => Array.from(g)),
      fractions: BANDS.map((_, i) => this.bandFraction(i)),
      count: this.views.length,
    };
  }
}

// Consiglio testuale in base alla copertura e alla vista corrente.
export function advice(fractions, el) {
  const b = bandOf(el);
  const f = fractions[b];
  const done = fractions.map((x, i) => (x >= 0.9 ? i : -1)).filter((i) => i >= 0);
  if (f < 0.9) return `Giro a ${Math.round(el)}° (${BANDS[b].label}): ${Math.round(f * 100)}% — continua a ruotare`;
  const wanted = [1, 2, 3].filter((i) => !done.includes(i));
  if (wanted.length) {
    const target = BANDS[wanted[0]];
    return `Giro a ${Math.round(el)}° completo. Sposta il telefono a circa ${Math.round((target.min + target.max) / 2)}° di elevazione`;
  }
  return 'Copertura ottima: puoi generare il modello';
}
