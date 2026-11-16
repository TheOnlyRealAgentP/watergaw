// MapLibre custom layer that draws one radar sweep from its native polar data.
//
// The sweep's byte codes go to the GPU untouched (an R8UI texture, gates x
// radials). A 256-entry table turns codes into physical values, and the
// fragment shader colors each pixel from a palette texture. Because the GPU
// sees real values, smoothing interpolates the data (not colors), storm-
// relative velocity is computed per pixel, and range highlighting is exact.

import { TEX_WIDTH } from './palettes.js';

const VS = `#version 300 es
in vec4 a_v;               // mercator dx, dy from the radar; azimuth deg; slant range km
uniform mat4 u_matrix;
out vec2 v_polar;
void main() {
  v_polar = a_v.zw;
  gl_Position = u_matrix * vec4(a_v.xy, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
in vec2 v_polar;
uniform usampler2D u_data;     // codes: width = gates, height = rows
uniform highp sampler2D u_lut; // 256x1: r = value, g = flag (0 ok, 1 no data, 2 range folded)
uniform sampler2D u_pal;       // TEX_WIDTH x 1 premultiplied RGBA over [vmin, vmax]
uniform float u_az0, u_delta, u_first, u_gate, u_maxkm;
uniform int u_rows, u_gates;
uniform vec2 u_domain;
uniform bool u_smooth, u_categorical;
uniform vec2 u_storm;          // storm motion toward (east, north) m/s; zero = plain velocity
uniform vec2 u_filter;         // show only values in [x, y] when x < y
uniform vec4 u_rf;             // range-folded color (premultiplied)
uniform float u_opacity;
out vec4 frag;

float stormComponent(float azDeg) {
  float a = radians(azDeg);
  return u_storm.x * sin(a) + u_storm.y * cos(a);
}

vec2 sampleAt(int gate, int row) {
  row = (row % u_rows + u_rows) % u_rows;
  if (gate < 0 || gate >= u_gates) return vec2(0.0, 1.0);
  uint c = texelFetch(u_data, ivec2(gate, row), 0).r;
  return texelFetch(u_lut, ivec2(int(c), 0), 0).rg;
}

void main() {
  float az = mod(v_polar.x, 360.0);
  float r = v_polar.y;
  if (r > u_maxkm) discard;
  float fg = (r - u_first) / u_gate;
  float fr = (az - u_az0) / u_delta;
  if (fg < 0.0 || fg >= float(u_gates)) discard;

  vec2 nearest = sampleAt(int(floor(fg)), int(floor(fr)));
  float value;
  if (!u_smooth || u_categorical) {
    if (nearest.y > 1.5) { frag = u_rf * u_opacity; return; }
    if (nearest.y > 0.5) discard;
    value = nearest.x;
  } else {
    // Bilinear between gate/radial centres, ignoring gates without data.
    float gx = fg - 0.5, ry = fr - 0.5;
    int g0 = int(floor(gx)), r0 = int(floor(ry));
    vec2 t = vec2(gx - floor(gx), ry - floor(ry));
    float sum = 0.0, wsum = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 s = sampleAt(g0 + i, r0 + j);
        float w = (i == 0 ? 1.0 - t.x : t.x) * (j == 0 ? 1.0 - t.y : t.y);
        if (s.y < 0.5) { sum += s.x * w; wsum += w; }
      }
    }
    if (wsum < 0.35) {
      if (nearest.y > 1.5) { frag = u_rf * u_opacity; return; }
      discard;
    }
    value = sum / wsum;
  }
  if (u_storm != vec2(0.0)) value -= stormComponent(az);
  if (u_filter.x < u_filter.y && (value < u_filter.x || value > u_filter.y)) discard;
  float x = (value - u_domain.x) / (u_domain.y - u_domain.x);
  if (x < 0.0) discard;
  vec4 c = texture(u_pal, vec2(clamp(x, 0.0, 1.0), 0.5));
  if (c.a < 0.004) discard;
  frag = c * u_opacity;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// Column-major 4x4 multiply (out = a * b), in float64.
function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export class RadarLayer {
  /** @param {object} core  main-thread WASM helpers (meshes) */
  constructor(id, core) {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this.core = core;
    this.sweep = null;
    this.visible = true;
    this.opts = { smooth: true, opacity: 1, storm: [0, 0], filter: [0, 0], domain: [0, 1], categorical: false, rf: [0.49, 0.2, 0.63, 1] };
    this.meshes = new Map();
    this.textures = new Map(); // sweep key -> { data, lut }
    this.paletteDirty = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    if (!(gl instanceof WebGL2RenderingContext)) {
      this.failed = 'WebGL 2 is not available in this browser.';
      return;
    }
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.program = p;
    this.u = {};
    for (const n of ['u_matrix', 'u_data', 'u_lut', 'u_pal', 'u_az0', 'u_delta', 'u_first', 'u_gate', 'u_maxkm', 'u_rows', 'u_gates',
      'u_domain', 'u_smooth', 'u_categorical', 'u_storm', 'u_filter', 'u_rf', 'u_opacity']) {
      this.u[n] = gl.getUniformLocation(p, n);
    }
    this.aV = gl.getAttribLocation(p, 'a_v');
    this.palTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEX_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(TEX_WIDTH * 4));
    this.texParams(gl, gl.NEAREST);
    if (this.paletteDirty) this.setPalette(...this.paletteDirty);
  }

  onRemove() {
    const gl = this.gl;
    if (!gl || this.failed) return;
    for (const t of this.textures.values()) { gl.deleteTexture(t.data); gl.deleteTexture(t.lut); }
    for (const m of this.meshes.values()) { gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.ibo); gl.deleteVertexArray(m.vao); }
    gl.deleteTexture(this.palTex);
    gl.deleteProgram(this.program);
    this.textures.clear();
    this.meshes.clear();
  }

  texParams(gl, filter) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setPalette(pixels, domain, rf, categorical) {
    this.opts.domain = domain;
    this.opts.categorical = !!categorical;
    this.opts.rf = rf.map((c, i) => (i < 3 ? (c / 255) * (rf[3] / 255) : c / 255));
    if (!this.gl || this.failed) { this.paletteDirty = [pixels, domain, rf, categorical]; return; }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_WIDTH, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.map?.triggerRepaint();
  }

  setOptions(o) {
    Object.assign(this.opts, o);
    this.map?.triggerRepaint();
  }

  setSweep(sweep) {
    this.sweep = sweep;
    this.map?.triggerRepaint();
  }

  setVisible(v) {
    this.visible = v;
    this.map?.triggerRepaint();
  }

  /** Drop GPU textures for sweeps no longer in use. */
  retain(keys) {
    if (!this.gl || this.failed) return;
    for (const [k, t] of this.textures) {
      if (!keys.has(k)) {
        this.gl.deleteTexture(t.data);
        this.gl.deleteTexture(t.lut);
        this.textures.delete(k);
      }
    }
  }

  texturesFor(s) {
    let t = this.textures.get(s.key);
    if (t) return t;
    const gl = this.gl;
    const m = s.meta;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, data);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, m.gates, m.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, s.codes);
    this.texParams(gl, gl.NEAREST);
    const lutPx = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      lutPx[i * 4] = Number.isFinite(s.lut[i]) ? s.lut[i] : 0;
      lutPx[i * 4 + 1] = s.flags[i];
    }
    const lut = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, lutPx);
    this.texParams(gl, gl.NEAREST);
    t = { data, lut };
    this.textures.set(s.key, t);
    return t;
  }

  meshFor(m) {
    const maxKm = m.first_gate_km + m.gates * m.gate_km;
    const el = Math.round(m.elevation * 10) / 10;
    const key = `${m.lat},${m.lon},${el},${maxKm}`;
    let mesh = this.meshes.get(key);
    if (mesh) return mesh;
    const rings = Math.max(16, Math.ceil(maxKm / 5));
    const { vertices, indices } = this.core.sweepMesh(m.lat, m.lon, el, maxKm, 720, rings);
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aV);
    gl.vertexAttribPointer(this.aV, 4, gl.FLOAT, false, 16, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    mesh = { vao, vbo, ibo, count: indices.length, maxKm };
    if (this.meshes.size > 12) {
      const [k, old] = this.meshes.entries().next().value;
      gl.deleteBuffer(old.vbo); gl.deleteBuffer(old.ibo); gl.deleteVertexArray(old.vao);
      this.meshes.delete(k);
    }
    this.meshes.set(key, mesh);
    return mesh;
  }

  render(gl, args) {
    const s = this.sweep;
    if (!s || !this.visible || this.failed || !this.program) return;
    const m = s.meta;
    const mesh = this.meshFor(m);
    const tex = this.texturesFor(s);

    // Relative-to-centre matrix, built in float64 so deep zooms don't jitter.
    const ws = this.map.transform.worldSize;
    const x = (m.lon + 180) / 360;
    const sl = Math.sin((Math.max(-85.0511, Math.min(85.0511, m.lat)) * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI);
    const model = new Float64Array([ws, 0, 0, 0, 0, ws, 0, 0, 0, 0, 1, 0, x * ws, y * ws, 0, 1]);
    const matrix = new Float32Array(mul(args.modelViewProjectionMatrix, model));

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.u.u_matrix, false, matrix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.data);
    gl.uniform1i(this.u.u_data, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex.lut);
    gl.uniform1i(this.u.u_lut, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.uniform1i(this.u.u_pal, 2);
    const o = this.opts;
    gl.uniform1f(this.u.u_az0, m.az0);
    gl.uniform1f(this.u.u_delta, m.delta);
    gl.uniform1f(this.u.u_first, m.first_gate_km);
    gl.uniform1f(this.u.u_gate, m.gate_km);
    gl.uniform1f(this.u.u_maxkm, mesh.maxKm);
    gl.uniform1i(this.u.u_rows, m.rows);
    gl.uniform1i(this.u.u_gates, m.gates);
    gl.uniform2f(this.u.u_domain, o.domain[0], o.domain[1]);
    gl.uniform1i(this.u.u_smooth, o.smooth ? 1 : 0);
    gl.uniform1i(this.u.u_categorical, o.categorical || m.categorical ? 1 : 0);
    gl.uniform2f(this.u.u_storm, o.storm[0], o.storm[1]);
    gl.uniform2f(this.u.u_filter, o.filter[0], o.filter[1]);
    gl.uniform4f(this.u.u_rf, ...o.rf);
    gl.uniform1f(this.u.u_opacity, o.opacity);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
