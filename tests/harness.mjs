// Mini-harness: in Node usa node:test (CI), nel browser raccoglie i test per
// tests/run.html. Così gli stessi file girano in entrambi i posti.

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
const nodeTest = isNode ? (await import('node:test')).test : null;

export const registry = [];

export function test(name, fn) {
  if (nodeTest) return nodeTest(name, fn);
  registry.push({ name, fn });
}

function fail(msg) {
  throw new Error(msg);
}

export const assert = {
  ok(v, msg = 'atteso vero') { if (!v) fail(msg); },
  equal(a, b, msg) { if (a !== b) fail(msg || `atteso ${b}, ottenuto ${a}`); },
  close(a, b, tol, msg) {
    if (!(Math.abs(a - b) <= tol)) fail(`${msg || 'valore'}: atteso ${b} ± ${tol}, ottenuto ${a}`);
  },
  atLeast(a, b, msg) { if (!(a >= b)) fail(`${msg || 'valore'}: atteso ≥ ${b}, ottenuto ${a}`); },
  atMost(a, b, msg) { if (!(a <= b)) fail(`${msg || 'valore'}: atteso ≤ ${b}, ottenuto ${a}`); },
};

export async function runRegistered(log) {
  let pass = 0;
  let failed = 0;
  for (const t of registry) {
    const t0 = performance.now();
    try {
      await t.fn();
      pass++;
      log({ name: t.name, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      failed++;
      log({ name: t.name, ok: false, ms: performance.now() - t0, error: e && e.stack ? e.stack : String(e) });
    }
  }
  return { pass, failed };
}
