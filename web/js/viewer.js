// Visore 3D minimale in WebGL2: il solido che cresce, il bersaglio e le
// posizioni da cui sono stati presi i fotogrammi. Trascina per ruotare,
// pizzica o usa la rotella per lo zoom, doppio tocco per ricentrare.

const VS = `#version 300 es
in vec3 p; in vec3 n;
uniform mat4 mvp; uniform mat4 mv; uniform float ps;
out vec3 vn;
void main() { gl_Position = mvp * vec4(p, 1.0); vn = mat3(mv) * n; gl_PointSize = ps; }`;

const FS = `#version 300 es
precision mediump float;
in vec3 vn; uniform vec3 col; uniform float lit; out vec4 o;
void main() {
  if (lit < 0.5) { o = vec4(col, 1.0); return; }
  vec3 N = normalize(vn); if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(vec3(0.35, 0.55, 1.0));
  float d = max(dot(N, L), 0.0);
  float s = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);
  o = vec4(col * (0.3 + 0.7 * d) + 0.18 * s, 1.0);
}`;

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, at, up) {
  const z = norm3([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1];
}

function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
    this.gl = gl;
    if (!gl) return;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    this.prog = prog;
    this.loc = {
      p: gl.getAttribLocation(prog, 'p'), n: gl.getAttribLocation(prog, 'n'),
      mvp: gl.getUniformLocation(prog, 'mvp'), mv: gl.getUniformLocation(prog, 'mv'),
      col: gl.getUniformLocation(prog, 'col'), lit: gl.getUniformLocation(prog, 'lit'), ps: gl.getUniformLocation(prog, 'ps'),
    };
    this.mesh = null;
    this.yaw = -0.6;
    this.pitch = 0.45;
    this.dist = 320;
    this.target = [0, 0, 40];
    this.autoRotate = true;
    this.color = [0.85, 0.62, 0.38];
    this.ground = null;
    this.cams = null;
    this.setBoard(100, 66);
    this.bindInput();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  get ok() { return !!this.gl; }

  buffer(data, target = this.gl.ARRAY_BUFFER) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }

  setBoard(radius, clearRadius) {
    if (!this.gl) return;
    const pts = [];
    const ring = (r, z) => {
      for (let k = 0; k < 96; k++) {
        const a0 = (k / 96) * Math.PI * 2, a1 = ((k + 1) / 96) * Math.PI * 2;
        pts.push(r * Math.cos(a0), r * Math.sin(a0), z, r * Math.cos(a1), r * Math.sin(a1), z);
      }
    };
    ring(radius, 0);
    ring(clearRadius, 0);
    pts.push(0, 0, 0, radius * 0.25, 0, 0); // asse X
    pts.push(0, 0, 0, 0, radius * 0.25, 0); // asse Y
    const p = new Float32Array(pts);
    this.ground = { vb: this.buffer(p), nb: this.buffer(new Float32Array(p.length)), count: p.length / 3 };
  }

  setCameras(points) {
    if (!this.gl) return;
    const p = new Float32Array(points.flat());
    this.cams = p.length ? { vb: this.buffer(p), nb: this.buffer(new Float32Array(p.length)), count: p.length / 3 } : null;
  }

  setMesh(m) {
    if (!this.gl) return;
    const gl = this.gl;
    if (this.mesh) { gl.deleteBuffer(this.mesh.vb); gl.deleteBuffer(this.mesh.nb); gl.deleteBuffer(this.mesh.ib); }
    if (!m || !m.indices.length) { this.mesh = null; return; }
    this.mesh = {
      vb: this.buffer(m.positions), nb: this.buffer(m.normals),
      ib: this.buffer(m.indices, gl.ELEMENT_ARRAY_BUFFER), count: m.indices.length,
    };
    let zmax = 0;
    for (let i = 2; i < m.positions.length; i += 3) zmax = Math.max(zmax, m.positions[i]);
    this.target = [0, 0, Math.max(10, zmax / 2)];
  }

  bindInput() {
    const c = this.canvas;
    const pts = new Map();
    let lastTap = 0;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      this.autoRotate = false;
      const now = performance.now();
      if (now - lastTap < 300) { this.yaw = -0.6; this.pitch = 0.45; this.dist = 320; this.autoRotate = true; }
      lastTap = now;
    });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      if (pts.size === 1) {
        this.yaw -= (e.clientX - prev[0]) * 0.008;
        this.pitch = Math.max(-1.4, Math.min(1.5, this.pitch + (e.clientY - prev[1]) * 0.008));
      } else if (pts.size === 2) {
        const other = [...pts.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
        const d1 = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
        if (d0 > 0) this.dist = Math.max(60, Math.min(1500, this.dist * (d0 / d1)));
      }
      pts.set(e.pointerId, [e.clientX, e.clientY]);
    });
    const up = (e) => pts.delete(e.pointerId);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(60, Math.min(1500, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  loop() {
    requestAnimationFrame(this.loop);
    const { gl, canvas } = this;
    if (!canvas.isConnected || canvas.offsetParent === null) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (this.autoRotate) this.yaw += 0.004;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const eye = [
      this.target[0] + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[1] + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[2] + this.dist * Math.sin(this.pitch),
    ];
    const view = lookAt(eye, this.target, [0, 0, 1]);
    const proj = perspective(0.75, w / h, 5, 5000);
    const mvp = mul4(proj, view);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.mvp, false, mvp);
    gl.uniformMatrix4fv(this.loc.mv, false, view);
    const draw = (obj, mode, col, lit, ps = 1) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, obj.vb);
      gl.enableVertexAttribArray(this.loc.p);
      gl.vertexAttribPointer(this.loc.p, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, obj.nb);
      gl.enableVertexAttribArray(this.loc.n);
      gl.vertexAttribPointer(this.loc.n, 3, gl.FLOAT, false, 0, 0);
      gl.uniform3fv(this.loc.col, col);
      gl.uniform1f(this.loc.lit, lit);
      gl.uniform1f(this.loc.ps, ps * dpr);
      if (obj.ib) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obj.ib);
        gl.drawElements(mode, obj.count, gl.UNSIGNED_INT, 0);
      } else {
        gl.drawArrays(mode, 0, obj.count);
      }
    };
    if (this.ground) draw(this.ground, gl.LINES, [0.55, 0.62, 0.7], 0);
    if (this.cams) draw(this.cams, gl.POINTS, [0.3, 0.85, 1.0], 0, 5);
    if (this.mesh) draw(this.mesh, gl.TRIANGLES, this.color, 1);
  }
}
