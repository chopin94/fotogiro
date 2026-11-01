// Interfaccia: sorgenti video (fotocamera, file, demo), guida durante la
// scansione, piatto motorizzato, anteprima 3D ed esportazione.

import { Viewer } from './viewer.js';
import { Turntable, bluetoothAvailable } from './turntable.js';
import { DEFAULTS } from './scanner.js';
import { BANDS, AZ_BINS, advice } from './coverage.js';
import { project, cameraCenter } from './geometry.js';

const $ = (id) => document.getElementById(id);
const STORE = 'fotogiro.settings';
const FOCAL_STORE = 'fotogiro.focal';
// debug acceso di default finché il progetto è in prova: si spegne dalle impostazioni
const APP_DEFAULTS = { ...DEFAULTS, tableStep: 5, tableSettle: 600, tableSpeed: 30, smooth: 6, debug: true };
const MAX_SIDE = 1280;
// queste impostazioni cambiano la scansione: se cambiano si ricomincia
const SCAN_KEYS = ['boardDiameter', 'volRadius', 'volHeight', 'voxel', 'tolerance', 'sensitivity', 'fillHoles', 'shadows', 'azStep', 'maxSpeed', 'focal'];

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* memoria non disponibile */ }
}

let settings = { ...APP_DEFAULTS, ...readJSON(STORE, {}) };
if (new URLSearchParams(location.search).has('debug')) settings.debug = true;

const state = {
  mode: 'idle',
  running: false,
  busy: false,
  frameId: 0,
  inflightForced: false,
  frameSize: [1280, 720],
  stream: null,
  wakeLock: null,
  last: null,
  mask: null,
  maskTime: 0,
  coverage: null,
  keyCams: [],
  keyframes: 0,
  focalKey: null,
  focalN: 0,
  board: null,
  volume: null,
  stats: null,
  forceNext: false,
  forcedWaiter: null,
  auto: false,
  final: null,
  video: { t: 0, dt: 1 / 8, duration: 0 },
  demo: { list: [], i: 0 },
};
window.__fotogiro = state;

const video = $('video');
const frameCanvas = $('frameCanvas');
const overlay = $('overlay');
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');
const viewer = new Viewer($('view3d'));
const table = new Turntable();
let worker = null;
let demoWorker = null;

// ---------------------------------------------------------------- utilità

let toastTimer = 0;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(el, ev, timeout = 4000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); el.removeEventListener(ev, done); resolve(); };
    const timer = setTimeout(done, timeout);
    el.addEventListener(ev, done);
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}

function fileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `fotogiro-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

const aspectKey = (w, h) => `${Math.max(w, h)}x${Math.min(w, h)}`;

function loadFocal(key) {
  return (key && readJSON(FOCAL_STORE, {})[key]) || 0;
}
function saveFocal(key, f) {
  if (!key) return;
  const all = readJSON(FOCAL_STORE, {});
  all[key] = f;
  writeJSON(FOCAL_STORE, all);
}

function setGuide(text, cls = '') {
  const g = $('guide');
  if (g.textContent !== text) g.textContent = text;
  g.className = `guide ${cls}`;
}

// ---------------------------------------------------------------- debug

const logLines = [];
const dbg = { fps: 0, lastFrameAt: 0, lastReason: '', lastWarn: '' };

function log(msg) {
  const t = new Date().toISOString().slice(11, 23);
  logLines.push(`${t} ${msg}`);
  if (logLines.length > 3000) logLines.shift();
  if (!settings.debug) return;
  const el = $('dbgLog');
  el.textContent = logLines.slice(-150).join('\n');
  el.scrollTop = el.scrollHeight;
}

function applyDebug() {
  $('debugPanel').hidden = !settings.debug;
  if (settings.debug) log(`debug attivo · ${navigator.userAgent}`);
}

function updateDebug(r) {
  const now = performance.now();
  if (dbg.lastFrameAt) dbg.fps = 0.8 * dbg.fps + 0.2 * (1000 / Math.max(1, now - dbg.lastFrameAt));
  dbg.lastFrameAt = now;
  const reason = r.ok ? '' : r.reason;
  if (reason !== dbg.lastReason) { if (reason) log(`! ${reason} (${r.markers.length} marker)`); dbg.lastReason = reason; }
  const warn = r.warnings.join(', ');
  if (warn !== dbg.lastWarn) { if (warn) log(`! ${warn}`); dbg.lastWarn = warn; }
  if (r.keyframe) log(`chiave #${state.keyframes} az ${r.ok ? r.azimuth.toFixed(1) : '-'} el ${r.ok ? r.elevation.toFixed(1) : '-'} rms ${r.ok ? r.rms.toFixed(2) : '-'} marker ${r.markerCount}${r.calibrating ? ' (in attesa di calibrazione)' : ''}`);
  if (r.flushed) log(`integrati ${r.flushed} fotogrammi in attesa dopo la calibrazione`);
  if (!settings.debug) return;
  const t = r.timings || {};
  const ms = (v) => (v == null ? '–' : v.toFixed(0));
  const s = state.stats;
  const [fw, fh] = state.frameSize;
  $('dbgInfo').textContent = [
    `fonte ${state.mode} ${fw}×${fh} · rilevamento ${(r.detectSize || []).join('×')} · ${dbg.fps.toFixed(1)} fps`,
    `marker ${r.markers.length} [${(r.markerIds || r.markers.map((m) => m.id)).join(' ')}]${r.ok ? ` · usati ${r.markerCount} · rms ${r.rms.toFixed(2)} px` : ` · ${r.reason}`}`,
    `tempi ms: marker ${ms(t.detect)} · posa ${ms(t.pose)} · silhouette ${ms(t.segment)} · scultura ${ms(t.carve)}${t.backlog ? ` · arretrati ${ms(t.backlog)}` : ''} · totale ${ms(t.total)}`,
    `focale ${state.focalN ? `${state.focalN.toFixed(4)} (${r.f ? r.f.toFixed(0) : '–'} px)` : `in calibrazione ${Math.round((r.calibProgress || 0) * 100)}%`}`,
    r.ok ? `vista az ${r.azimuth.toFixed(1)}° el ${r.elevation.toFixed(1)}° dist ${r.distance.toFixed(0)} mm · ${r.speed.toFixed(1)}°/s` : 'vista –',
    `chiave ${state.keyframes} · integrate ${r.views ?? '–'} · voxel ${settings.voxel} mm · tolleranza ${settings.tolerance}`,
    s ? `volume ${s.volumeCm3.toFixed(1)} cm³ · ${s.size.map((v) => v.toFixed(0)).join('×')} mm${s.touchTop ? ' · TOCCA IL TETTO' : ''}${s.touchSide ? ' · TOCCA IL BORDO' : ''}` : 'volume –',
    r.warnings.length ? `avvisi: ${r.warnings.join(', ')}` : 'avvisi: nessuno',
  ].join('\n');
}

function saveDebugFrame() {
  const src = state.mode === 'demo' ? frameCanvas : grab;
  if (!src.width) { toast('Nessun fotogramma da salvare'); return; }
  const r = state.last || {};
  const data = {
    app: 'fotogiro',
    time: new Date().toISOString(),
    mode: state.mode,
    settings,
    focalN: state.focalN,
    frame: { w: src.width, h: src.height, png: src.toDataURL('image/png') },
    result: { ...r, coverage: undefined },
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), fileName('fotogramma.json'));
  log(`fotogramma salvato (${src.width}×${src.height})`);
}

function setProgress(f) {
  const p = $('progress');
  p.hidden = f == null;
  if (f != null) p.firstElementChild.style.width = `${Math.round(f * 100)}%`;
}

// ---------------------------------------------------------------- worker

function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => { toast(`Errore di elaborazione: ${e.message || 'sconosciuto'}`); state.busy = false; };
  state.busy = false;
  state.last = null;
  state.mask = null;
  state.coverage = null;
  state.keyCams = [];
  state.keyframes = 0;
  state.stats = null;
  state.final = null;
  viewer.setMesh(null);
  viewer.setCameras([]);
  $('report').textContent = '';
  for (const id of ['btnStl', 'btnObj', 'btnShare', 'btnBuild']) $(id).disabled = true;
  const s = { ...settings };
  if (!s.focal && state.focalN) s.focal = state.focalN;
  worker.postMessage({ type: 'init', settings: s });
  drawCoverage();
  updateStats();
}

function onWorker(e) {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      state.board = m.board;
      state.volume = m.volume;
      viewer.setBoard(m.board.radius, m.volume.radius);
      updateFocalChip(m.focalN);
      log(`pronto: bersaglio Ø${m.board.diameter} mm (${m.board.count} marker, area libera Ø${Math.floor(m.board.clearRadius * 2)}) · volume r${m.volume.radius} h${m.volume.height} · focale ${m.focalN ? m.focalN.toFixed(4) : 'da calibrare'}`);
      break;
    case 'frame':
      state.busy = false;
      handleFrame(m);
      scheduleNext();
      break;
    case 'focal':
      state.focalN = m.focalN;
      saveFocal(state.focalKey, m.focalN);
      updateFocalChip(m.focalN);
      toast(`Obiettivo calibrato (errore medio ${m.rms.toFixed(2)} px)`);
      log(`calibrazione: focale ${m.focalN.toFixed(4)} · rms ${m.rms.toFixed(3)} px · chiave ${state.focalKey}`);
      break;
    case 'mesh':
      if (!state.final) viewer.setMesh(m);
      state.stats = m.stats;
      updateStats();
      break;
    case 'final':
      onFinal(m);
      break;
    case 'obj':
      download(new Blob([m.text], { type: 'text/plain' }), fileName('obj'));
      break;
    case 'error':
      console.error(m.message);
      log(`ERRORE worker: ${m.message}`);
      toast(`Errore: ${m.message.split('\n')[0]}`);
      state.busy = false;
      $('btnBuild').disabled = false;
      scheduleNext();
      break;
  }
}

function sendFrame(source, sw, sh, time, force) {
  const s = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const w = Math.round(sw * s), h = Math.round(sh * s);
  if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
  gctx.drawImage(source, 0, 0, w, h);
  const img = gctx.getImageData(0, 0, w, h);
  postFrame(img.data.buffer, w, h, time, force);
}

function postFrame(buf, w, h, time, force) {
  state.busy = true;
  state.inflightForced = force;
  state.frameSize = [w, h];
  worker.postMessage({ type: 'frame', id: ++state.frameId, buf, w, h, time, force }, [buf]);
}

function consumeForce() {
  const f = state.forceNext;
  state.forceNext = false;
  return f;
}

function scheduleNext() {
  if (!state.running) return;
  if (state.mode === 'camera') requestAnimationFrame(pumpCamera);
  else if (state.mode === 'video') nextVideoFrame();
  else if (state.mode === 'demo') nextDemoFrame();
}

function handleFrame(m) {
  const r = m.res;
  state.last = r;
  if (m.mask) {
    state.mask = { data: m.mask, w: m.maskW, h: m.maskH };
    state.maskTime = performance.now();
  }
  if (r.keyframe) {
    state.keyframes++;
    if (r.ok) {
      state.keyCams.push(cameraCenter(r.R, r.t));
      viewer.setCameras(state.keyCams);
    }
  }
  if (r.coverage) state.coverage = r.coverage;
  const wasForced = state.inflightForced;
  if (wasForced && state.forcedWaiter) {
    const w = state.forcedWaiter;
    if (r.ok || --w.tries <= 0) { state.forcedWaiter = null; w.resolve(r); } else state.forceNext = true;
  }
  drawOverlay();
  drawCoverage();
  updateGuide(r);
  updateHud(r);
  updateStats();
  updateDebug(r);
  $('btnBuild').disabled = !(r.views >= 6 || (state.stats && state.stats.views >= 6));
}

// ---------------------------------------------------------------- sorgenti

function showSource(kind) {
  video.hidden = kind !== 'video';
  frameCanvas.hidden = kind !== 'canvas';
  $('startPanel').hidden = true;
  $('stage').classList.remove('intro');
}

function setMode(mode) {
  if (mode !== state.mode) log(`modalità: ${mode}`);
  state.mode = mode;
  $('btnPause').disabled = mode === 'idle';
  $('btnPause').textContent = 'Pausa';
  for (const b of document.querySelectorAll('[data-act="camera"]')) b.classList.toggle('active', mode === 'camera');
  $('btnDemo').classList.toggle('active', mode === 'demo');
  updateTableUi();
}

function stopAll() {
  state.running = false;
  state.auto = false;
  if (state.stream) { for (const t of state.stream.getTracks()) t.stop(); state.stream = null; }
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  setProgress(null);
  setMode('idle');
}

function finishSource(msg) {
  state.running = false;
  setProgress(null);
  $('btnPause').disabled = true;
  toast(msg);
}

async function requestWakeLock() {
  try { if (navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* non supportato */ }
}

async function startCamera() {
  stopAll();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Fotocamera non disponibile: serve HTTPS e un browser recente');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    toast(`Fotocamera non disponibile: ${err.message}`);
    return;
  }
  state.stream = stream;
  video.srcObject = stream;
  try { await video.play(); } catch { /* parte al primo tocco */ }
  const track = stream.getVideoTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};
  log(`fotocamera "${track.label}" ${st.width}×${st.height} @${st.frameRate || '?'} fps · ${JSON.stringify({ focusMode: st.focusMode, exposureMode: st.exposureMode, zoom: st.zoom })}`);
  state.focalKey = `cam:${track.label || 'posteriore'}:${aspectKey(st.width || video.videoWidth, st.height || video.videoHeight)}`;
  state.focalN = settings.focal || loadFocal(state.focalKey);
  showSource('video');
  setMode('camera');
  startWorker();
  state.running = true;
  requestWakeLock();
  setGuide('Inquadra il bersaglio con l’oggetto al centro');
  requestAnimationFrame(pumpCamera);
}

function pumpCamera() {
  if (!state.running || state.mode !== 'camera' || state.busy) return;
  if (video.readyState < 2 || !video.videoWidth) { requestAnimationFrame(pumpCamera); return; }
  sendFrame(video, video.videoWidth, video.videoHeight, performance.now() / 1000, consumeForce());
}

async function startVideo(file) {
  stopAll();
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.preload = 'auto';
  await once(video, 'loadedmetadata', 8000);
  if (!video.videoWidth) { toast('Video non leggibile da questo browser'); log(`video non leggibile: ${file.name} ${file.type}`); return; }
  log(`video "${file.name}" ${video.videoWidth}×${video.videoHeight} · ${video.duration.toFixed(1)} s`);
  try { await video.play(); video.pause(); } catch { /* alcuni browser non lo permettono */ }
  state.focalKey = `video:${aspectKey(video.videoWidth, video.videoHeight)}`;
  state.focalN = settings.focal || loadFocal(state.focalKey);
  showSource('video');
  setMode('video');
  startWorker();
  state.running = true;
  state.video = { t: 0, dt: 1 / 8, duration: video.duration };
  setGuide('Analizzo il video…');
  nextVideoFrame(true);
}

async function nextVideoFrame(first = false) {
  if (!state.running || state.mode !== 'video' || state.busy) return;
  const v = state.video;
  if (!first) v.t += v.dt;
  if (!(v.t < v.duration - 0.05)) {
    finishSource('Video analizzato');
    if (state.focalN) buildModel(); else setGuide('Video finito ma obiettivo non calibrato: servono più viste del bersaglio', 'bad');
    return;
  }
  state.busy = true;
  video.currentTime = v.t;
  await once(video, 'seeked');
  setProgress(v.t / v.duration);
  sendFrame(video, video.videoWidth, video.videoHeight, v.t, false);
}

function startDemo() {
  stopAll();
  showSource('canvas');
  state.focalKey = null;
  state.focalN = 0;
  setMode('demo');
  startWorker();
  if (!demoWorker) {
    demoWorker = new Worker(new URL('./demo-worker.js', import.meta.url), { type: 'module' });
    demoWorker.onmessage = onDemoFrame;
  }
  demoWorker.postMessage({ type: 'init', diameter: settings.boardDiameter });
  const list = [];
  for (const el of [20, 40, 60]) for (let a = 0; a < 360; a += 6) list.push({ el, a });
  state.demo = { list, i: 0 };
  state.running = true;
  setGuide('Demo: piatto e oggetto simulati, il piatto gira a passi di 6°');
  nextDemoFrame();
}

function nextDemoFrame() {
  if (!state.running || state.mode !== 'demo' || state.busy) return;
  const d = state.demo;
  if (d.i >= d.list.length) {
    finishSource('Demo completata: genero il modello');
    buildModel();
    return;
  }
  const it = d.list[d.i++];
  state.busy = true;
  setProgress(d.i / d.list.length);
  demoWorker.postMessage({ type: 'render', elevation: it.el, angle: it.a, w: 960, h: 540, seed: d.i });
}

function onDemoFrame(e) {
  const m = e.data;
  if (m.type !== 'frame' || state.mode !== 'demo') return;
  if (frameCanvas.width !== m.w || frameCanvas.height !== m.h) { frameCanvas.width = m.w; frameCanvas.height = m.h; }
  frameCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0);
  postFrame(m.buf, m.w, m.h, state.demo.i * 0.5, true);
}

// ---------------------------------------------------------------- disegno

function frameRect(cw, ch) {
  const [fw, fh] = state.frameSize;
  const sc = Math.min(cw / fw, ch / fh);
  return { sc, ox: (cw - fw * sc) / 2, oy: (ch - fh * sc) / 2, fw, fh };
}

function drawOverlay() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(overlay.clientWidth * dpr), ch = Math.round(overlay.clientHeight * dpr);
  if (!cw || !ch) return;
  if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  const r = state.last;
  if (!r) return;
  const { sc, ox, oy, fw, fh } = frameRect(cw, ch);
  const P = (p) => [ox + p[0] * sc, oy + p[1] * sc];
  // silhouette dell'ultimo fotogramma chiave
  if (state.mask && (state.maskAlways || performance.now() - state.maskTime < 1200)) {
    const { data, w, h } = state.mask;
    if (maskCanvas.width !== w || maskCanvas.height !== h) { maskCanvas.width = w; maskCanvas.height = h; }
    const mctx = maskCanvas.getContext('2d');
    const img = mctx.createImageData(w, h);
    for (let i = 0; i < data.length; i++) if (data[i]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 70; img.data[i * 4 + 2] = 200; img.data[i * 4 + 3] = 110; }
    mctx.putImageData(img, 0, 0);
    ctx.drawImage(maskCanvas, ox, oy, fw * sc, fh * sc);
  }
  ctx.lineWidth = 2 * dpr;
  ctx.font = `bold ${12 * dpr}px system-ui, sans-serif`;
  for (const m of r.markers) {
    ctx.strokeStyle = '#4cd18a';
    ctx.beginPath();
    m.corners.forEach((c, i) => { const q = P(c); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
    ctx.stroke();
    const q = P(m.corners[0]);
    ctx.fillStyle = '#4cd18a';
    ctx.fillRect(q[0] - 2 * dpr, q[1] - 2 * dpr, 4 * dpr, 4 * dpr);
    if (settings.debug) {
      const c = m.corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
      const cq = P(c);
      ctx.fillStyle = '#ffcf5c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.id), cq[0], cq[1]);
    }
  }
  if (r.ok && state.volume) {
    const { radius, height } = state.volume;
    ctx.strokeStyle = 'rgba(90,210,255,0.9)';
    ctx.lineWidth = 1.5 * dpr;
    const ring = (rad, z) => {
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const p = project(r.K, r.R, r.t, [rad * Math.cos(a), rad * Math.sin(a), z]);
        if (p[2] <= 0) return;
        const q = P(p);
        if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      }
      ctx.stroke();
    };
    ring(radius, 0);
    ring(radius, height);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const p0 = project(r.K, r.R, r.t, [radius * Math.cos(a), radius * Math.sin(a), 0]);
      const p1 = project(r.K, r.R, r.t, [radius * Math.cos(a), radius * Math.sin(a), height]);
      if (p0[2] <= 0 || p1[2] <= 0) continue;
      const a0 = P(p0), a1 = P(p1);
      ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]); ctx.stroke();
    }
    // asse X del bersaglio (rosso): utile per capire il verso di rotazione
    const o = P(project(r.K, r.R, r.t, [0, 0, 0]));
    const x = P(project(r.K, r.R, r.t, [radius * 0.6, 0, 0]));
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(x[0], x[1]); ctx.stroke();
  }
}

function elevationToRadius(el, R) {
  const n = BANDS.length;
  for (let b = 0; b < n; b++) {
    const B = BANDS[b];
    if (el < B.max || b === n - 1) {
      const f = Math.max(0, Math.min(1, (el - B.min) / (B.max - B.min)));
      return R * (1 - (b + f) / n);
    }
  }
  return 0;
}

function drawCoverage() {
  const c = $('coverage');
  const ctx = c.getContext('2d');
  const W = c.width;
  const cx = W / 2, cy = W / 2, R = W / 2 - 8;
  ctx.clearRect(0, 0, W, W);
  const grid = state.coverage && state.coverage.grid;
  const n = BANDS.length;
  const step = (Math.PI * 2) / AZ_BINS;
  for (let b = 0; b < n; b++) {
    const r1 = R * (1 - b / n), r0 = R * (1 - (b + 1) / n);
    for (let k = 0; k < AZ_BINS; k++) {
      const a0 = -Math.PI / 2 - k * step, a1 = a0 - step;
      ctx.beginPath();
      ctx.arc(cx, cy, r1 - 1, a1 + 0.01, a0 - 0.01);
      ctx.arc(cx, cy, Math.max(0, r0 + 1), a0 - 0.01, a1 + 0.01, true);
      ctx.closePath();
      ctx.fillStyle = grid && grid[b][k] ? '#ff9f43' : '#232a33';
      ctx.fill();
    }
  }
  const r = state.last;
  if (r && r.ok) {
    const rad = elevationToRadius(r.elevation, R);
    const a = -Math.PI / 2 - (r.azimuth * Math.PI) / 180;
    ctx.fillStyle = '#5ad2ff';
    ctx.strokeStyle = '#0f1216';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx + rad * Math.cos(a), cy + rad * Math.sin(a), 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#e9edf2';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(state.keyframes), cx, cy);
}

function updateHud(r) {
  const hud = $('hud');
  if (!r.ok) { hud.textContent = `${r.markers.length} marker`; return; }
  hud.textContent = `az ${r.azimuth.toFixed(0)}°  el ${r.elevation.toFixed(0)}°  ${(r.distance / 10).toFixed(0)} cm\n` +
    `${r.markerCount} marker  ${r.speed.toFixed(0)}°/s  ±${r.rms.toFixed(2)} px`;
}

function updateGuide(r) {
  if (state.mode === 'demo' && r.ok && !r.calibrating) {
    setGuide(`Demo — ${advice(r.coverage.fractions, r.elevation)}`);
    return;
  }
  let text, cls = '';
  if (!r.ok) {
    cls = 'bad';
    if (r.reason === 'bersaglio non trovato') text = 'Non vedo il bersaglio: inquadra tutto il foglio sul piatto';
    else if (r.reason === 'pochi marker visibili') text = 'Vedo pochi marker: allontana il telefono o inclinalo di più verso il basso';
    else text = 'Posa incerta: tieni fermo il telefono e controlla la luce';
  } else if (r.calibrating) {
    cls = 'warn';
    text = `Calibrazione dell’obiettivo: fai girare il piatto lentamente… ${Math.round((r.calibProgress || 0) * 100)}%`;
  } else if (r.warnings.includes('troppo veloce')) {
    cls = 'warn';
    text = state.auto ? 'Il piatto si muove: attendo che si fermi' : 'Troppo veloce: gira più piano o fermati un attimo ogni pochi gradi';
  } else if (r.warnings.length) {
    cls = 'warn';
    text = r.warnings[0].charAt(0).toUpperCase() + r.warnings[0].slice(1);
  } else {
    text = advice(r.coverage.fractions, r.elevation);
    if (text.startsWith('Copertura ottima')) cls = 'ok';
    if (r.elevation > 75) { text = 'Vista troppo dall’alto: abbassa un po’ il telefono'; cls = 'warn'; }
  }
  if (state.stats && state.stats.touchTop) { text += ' · L’oggetto tocca il tetto del volume: aumenta l’altezza nelle impostazioni'; cls = 'warn'; }
  else if (state.stats && state.stats.touchSide) { text += ' · L’oggetto esce dal cilindro: aumenta il raggio del volume'; cls = 'warn'; }
  setGuide(text, cls);
}

function updateStats() {
  $('stKeys').textContent = String(state.keyframes);
  const s = state.stats;
  $('stVol').textContent = s && s.volumeCm3 ? `${s.volumeCm3.toFixed(1)} cm³` : '–';
  $('stSize').textContent = s && s.size && s.size[2] ? `${s.size.map((v) => v.toFixed(0)).join(' × ')} mm` : '–';
  const r = state.last;
  $('stView').textContent = r && r.ok ? `${r.azimuth.toFixed(0)}° / ${r.elevation.toFixed(0)}°` : '–';
  $('stRms').textContent = r && r.ok ? `${r.rms.toFixed(2)} px` : '–';
}

function updateFocalChip(f) {
  const c = $('chipFocal');
  c.textContent = f ? `Obiettivo: f ${f.toFixed(3)}` : 'Obiettivo: da calibrare';
  c.classList.toggle('ok', !!f);
}

// ---------------------------------------------------------------- modello

function buildModel() {
  if (!worker) return;
  $('btnBuild').disabled = true;
  setGuide('Genero il modello chiuso…');
  worker.postMessage({ type: 'final', smooth: settings.smooth });
}

function onFinal(m) {
  state.final = m;
  viewer.setMesh(m);
  setBig3d(true);
  const r = m.report;
  log(`modello: ${r.triangles} triangoli · chiuso ${r.watertight} (${r.badEdges} spigoli aperti) · ${r.size.map((v) => v.toFixed(1)).join('×')} mm · ${r.volumeCm3.toFixed(2)} cm³`);
  const size = r.size.map((v) => v.toFixed(1)).join(' × ');
  $('report').innerHTML = `<b>${r.triangles.toLocaleString('it-IT')}</b> triangoli · ` +
    (r.watertight ? '<span class="ok">solido chiuso, pronto da stampare</span>' : `<span class="bad">${r.badEdges} spigoli aperti</span>`) +
    ` · ${size} mm · ${r.volumeCm3.toFixed(1)} cm³`;
  for (const id of ['btnStl', 'btnObj', 'btnShare', 'btnBuild']) $(id).disabled = false;
  setGuide('Modello pronto: scarica l’STL e aprilo nello slicer', 'ok');
}

function setBig3d(on) {
  $('stage').classList.toggle('big3d', on);
}

// ---------------------------------------------------------------- piatto

function updateTableUi() {
  const c = table.connected;
  $('btnConnect').textContent = c ? 'Scollega piatto' : 'Collega piatto';
  $('btnConnect').disabled = !bluetoothAvailable();
  $('btnAuto').disabled = !c || state.mode !== 'camera';
  $('btnStep').disabled = !c;
  $('btnStep').textContent = `Ruota ${settings.tableStep}°`;
  $('btnAuto').textContent = state.auto ? 'Ferma giro' : 'Giro automatico';
  const chip = $('chipTable');
  chip.textContent = c ? `Piatto: ${table.position.toFixed(1)}°` : bluetoothAvailable() ? 'Piatto: manuale' : 'Piatto: manuale (no Bluetooth)';
  chip.classList.toggle('ok', c);
}

function waitForcedKeyframe(tries = 4) {
  return new Promise((resolve) => {
    state.forcedWaiter = { resolve, tries };
    state.forceNext = true;
  });
}

async function autoScan() {
  if (state.auto) { state.auto = false; updateTableUi(); return; }
  if (state.mode !== 'camera' || !state.running) { toast('Avvia prima la fotocamera'); return; }
  state.auto = true;
  updateTableUi();
  try {
    await table.speed(settings.tableSpeed);
    await table.motor(true);
    const n = Math.round(360 / settings.tableStep);
    for (let k = 0; k < n && state.auto; k++) {
      await waitForcedKeyframe();
      setProgress((k + 1) / n);
      await table.rotate(settings.tableStep);
      updateTableUi();
      await sleep(settings.tableSettle);
    }
    if (state.auto) toast('Giro completato: cambia altezza del telefono e ripeti, oppure genera il modello');
  } catch (err) {
    toast(`Piatto: ${err.message}`);
  } finally {
    state.auto = false;
    state.forcedWaiter = null;
    setProgress(null);
    table.motor(false).catch(() => {});
    updateTableUi();
  }
}

// ---------------------------------------------------------------- impostazioni

function fillSettingsForm() {
  const f = $('formSettings');
  for (const el of f.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = String(settings[el.name]);
  }
}

function readSettingsForm() {
  const f = $('formSettings');
  const out = { ...settings };
  for (const el of f.elements) {
    if (!el.name || !(el.name in settings)) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  return out;
}

function applySettings(next) {
  const changed = SCAN_KEYS.some((k) => next[k] !== settings[k]);
  settings = next;
  writeJSON(STORE, settings);
  applyDebug();
  log(`impostazioni: ${JSON.stringify(settings)}`);
  updateTableUi();
  if (changed && state.mode !== 'idle') {
    if (settings.focal) state.focalN = settings.focal;
    startWorker();
    toast('Impostazioni salvate: scansione ricominciata');
  } else {
    toast('Impostazioni salvate');
  }
}

// ---------------------------------------------------------------- eventi

for (const b of document.querySelectorAll('[data-act="camera"]')) b.addEventListener('click', startCamera);
for (const b of document.querySelectorAll('[data-act="demo"]')) b.addEventListener('click', startDemo);
for (const b of document.querySelectorAll('[data-swap]')) b.addEventListener('click', () => setBig3d(!$('stage').classList.contains('big3d')));

$('fileVideo').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) startVideo(f);
  e.target.value = '';
});

$('btnPause').addEventListener('click', () => {
  if (state.mode === 'idle') return;
  state.running = !state.running;
  $('btnPause').textContent = state.running ? 'Pausa' : 'Riprendi';
  if (state.running) scheduleNext();
});

$('btnReset').addEventListener('click', () => {
  if (state.keyframes > 0 && !confirm('Cancellare la scansione e ricominciare?')) return;
  if (!worker) return;
  startWorker();
  setBig3d(false);
  if (state.mode === 'demo') startDemo();
  else if (state.mode === 'video') { state.video.t = 0; state.running = true; nextVideoFrame(true); }
  else if (state.mode === 'camera') { state.running = true; requestAnimationFrame(pumpCamera); }
});

$('btnBuild').addEventListener('click', buildModel);

$('btnStl').addEventListener('click', () => {
  if (state.final) download(new Blob([state.final.stl], { type: 'model/stl' }), fileName('stl'));
});
$('btnObj').addEventListener('click', () => worker && worker.postMessage({ type: 'obj' }));
$('btnShare').addEventListener('click', async () => {
  if (!state.final) return;
  const file = new File([state.final.stl], fileName('stl'), { type: 'model/stl' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Modello 3D (Fotogiro)' });
    else download(file, file.name);
  } catch (err) {
    if (err.name !== 'AbortError') download(file, file.name);
  }
});

$('btnConnect').addEventListener('click', async () => {
  try {
    if (table.connected) table.disconnect();
    else { await table.connect(); toast('Piatto collegato'); }
  } catch (err) {
    if (err.name !== 'NotFoundError') toast(`Bluetooth: ${err.message}`);
  }
  updateTableUi();
});
$('btnAuto').addEventListener('click', autoScan);
$('btnStep').addEventListener('click', async () => {
  try { await table.rotate(settings.tableStep); } catch (err) { toast(err.message); }
  updateTableUi();
});
table.addEventListener('change', () => { log(`piatto ${table.connected ? 'collegato' : 'scollegato'}`); updateTableUi(); });
table.addEventListener('line', (e) => { log(`← ${e.detail}`); updateTableUi(); });
table.addEventListener('sent', (e) => log(`→ ${e.detail}`));

// debug
$('dbgShot').addEventListener('click', () => { state.forceNext = true; log('scatto forzato'); });
$('dbgSave').addEventListener('click', saveDebugFrame);
$('dbgLogSave').addEventListener('click', () => {
  const head = `Fotogiro – log\n${new Date().toISOString()}\n${navigator.userAgent}\nimpostazioni ${JSON.stringify(settings)}\nfocale ${state.focalN} (${state.focalKey})\n\n`;
  download(new Blob([head + logLines.join('\n')], { type: 'text/plain' }), fileName('log.txt'));
});
$('dbgMask').addEventListener('change', (e) => { state.maskAlways = e.target.checked; drawOverlay(); });
const sendRaw = async () => {
  const cmd = $('dbgCmd').value.trim();
  if (!cmd) return;
  try { await table.send(cmd); $('dbgCmd').value = ''; } catch (err) { toast(err.message); log(`! ${err.message}`); }
};
$('dbgSend').addEventListener('click', sendRaw);
$('dbgCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRaw(); });
window.addEventListener('error', (e) => log(`ERRORE: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => log(`ERRORE promessa: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

$('btnSettings').addEventListener('click', () => { fillSettingsForm(); $('dlgSettings').showModal(); });
$('dlgSettings').addEventListener('close', () => {
  if ($('dlgSettings').returnValue === 'ok') applySettings(readSettingsForm());
});
$('btnForgetFocal').addEventListener('click', () => {
  const all = readJSON(FOCAL_STORE, {});
  if (state.focalKey) delete all[state.focalKey];
  writeJSON(FOCAL_STORE, all);
  $('formSettings').elements.focal.value = '0';
  settings = { ...settings, focal: 0 };
  writeJSON(STORE, settings);
  state.focalN = 0;
  updateFocalChip(0);
  if (state.mode !== 'idle') startWorker();
  toast('Calibrazione dimenticata: verrà ripetuta');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running && state.mode === 'camera') requestWakeLock();
});
window.addEventListener('resize', drawOverlay);

drawCoverage();
updateTableUi();
updateStats();
applyDebug();
if (!viewer.ok) { $('mini3d').hidden = true; log('WebGL2 non disponibile: niente anteprima 3D'); }

// ---------------------------------------------------------------- PWA

if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const show = (w) => {
      $('update').hidden = false;
      $('btnUpdate').onclick = () => w.postMessage('skipWaiting');
    };
    if (reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) show(w);
      });
    });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) { reloading = true; location.reload(); }
  });
}
