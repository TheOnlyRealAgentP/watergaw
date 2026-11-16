// Animated surface wind, drawn as flowing particles on a canvas over the map.
//
// Current 10 m winds come from Open-Meteo for a grid of points across the
// view (one request). Particles move through a screen-space vector grid that
// is rebuilt whenever the map stops moving, and leave fading trails.

const API = 'https://api.open-meteo.com/v1/forecast';
const COLORS = [[0, '#6fa8dc'], [4, '#64d2ff'], [8, '#30d158'], [12, '#ffd60a'], [17, '#ff9f0a'], [24, '#ff453a'], [33, '#ff2dbe']];

export function windColor(ms) {
  let c = COLORS[0][1];
  for (const [v, col] of COLORS) if (ms >= v) c = col;
  return c;
}
export const WIND_STOPS = COLORS;

export class WindField {
  constructor() {
    this.field = null; // { w, s, e, n, nx, ny, u: Float32Array, v: Float32Array, time }
  }

  covers(b) {
    const f = this.field;
    return f && b.getWest() >= f.w && b.getEast() <= f.e && b.getSouth() >= f.s && b.getNorth() <= f.n && (f.e - f.w) < (b.getEast() - b.getWest()) * 3 && Date.now() - f.at < 30 * 60e3;
  }

  async load(bounds) {
    const padX = (bounds.getEast() - bounds.getWest()) * 0.15, padY = (bounds.getNorth() - bounds.getSouth()) * 0.15;
    const w = Math.max(-179.9, bounds.getWest() - padX), e = Math.min(179.9, bounds.getEast() + padX);
    const s = Math.max(-80, bounds.getSouth() - padY), n = Math.min(80, bounds.getNorth() + padY);
    const nx = 12, ny = 10;
    const lats = [], lons = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      lats.push((s + ((j + 0.5) / ny) * (n - s)).toFixed(3));
      lons.push((w + ((i + 0.5) / nx) * (e - w)).toFixed(3));
    }
    const q = `latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
    const res = await fetch(`${API}?${q}`);
    if (!res.ok) throw new Error(`wind data ${res.status}`);
    let d = await res.json();
    if (!Array.isArray(d)) d = [d];
    const u = new Float32Array(nx * ny), v = new Float32Array(nx * ny);
    d.forEach((p, k) => {
      const sp = p.current?.wind_speed_10m ?? 0, dir = ((p.current?.wind_direction_10m ?? 0) * Math.PI) / 180;
      // Meteorological direction is where the wind comes FROM.
      u[k] = -sp * Math.sin(dir);
      v[k] = -sp * Math.cos(dir);
    });
    this.field = { w, s, e, n, nx, ny, u, v, at: Date.now(), time: d[0]?.current?.time };
    return this.field;
  }

  /** Bilinear wind (m/s east, north) at a point. */
  at(lat, lon) {
    const f = this.field;
    if (!f || lon < f.w || lon > f.e || lat < f.s || lat > f.n) return null;
    const fx = Math.min(f.nx - 1.001, Math.max(0, ((lon - f.w) / (f.e - f.w)) * f.nx - 0.5));
    const fy = Math.min(f.ny - 1.001, Math.max(0, ((lat - f.s) / (f.n - f.s)) * f.ny - 0.5));
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const g = (a, ii, jj) => a[jj * f.nx + ii];
    const lerp = (a) => (g(a, i, j) * (1 - tx) + g(a, i + 1, j) * tx) * (1 - ty) + (g(a, i, j + 1) * (1 - tx) + g(a, i + 1, j + 1) * tx) * ty;
    return [lerp(f.u), lerp(f.v)];
  }
}

/** Particle animation for one map. */
export class WindAnimation {
  constructor(map, field) {
    this.map = map;
    this.field = field;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wind-canvas';
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.running = false;
    this.onStart = () => this.pause();
    this.onEnd = () => this.rebuild();
    map.on('movestart', this.onStart);
    map.on('moveend', this.onEnd);
    this.ro = new ResizeObserver(() => this.rebuild());
    this.ro.observe(map.getContainer());
  }

  destroy() {
    this.pause();
    this.map.off('movestart', this.onStart);
    this.map.off('moveend', this.onEnd);
    this.ro.disconnect();
    this.canvas.remove();
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Screen-space vector grid for the current view. */
  rebuild() {
    if (!this.field.field) return;
    const el = this.map.getContainer();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = el.clientWidth, H = el.clientHeight;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const step = 24;
    const gx = Math.ceil(W / step) + 1, gy = Math.ceil(H / step) + 1;
    const grid = new Float32Array(gx * gy * 3);
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
      const ll = this.map.unproject([i * step, j * step]);
      const w = this.field.at(ll.lat, ll.lng);
      const k = (j * gx + i) * 3;
      if (!w) { grid[k + 2] = -1; continue; }
      grid[k] = w[0];
      grid[k + 1] = w[1];
      grid[k + 2] = Math.hypot(w[0], w[1]);
    }
    this.grid = { gx, gy, step, data: grid, W, H };
    const n = Math.round(Math.min(3500, (W * H) / 260));
    this.parts = Array.from({ length: n }, () => this.spawn({}));
    this.running = true;
    cancelAnimationFrame(this.raf);
    this.loop();
  }

  spawn(p) {
    p.x = Math.random() * this.grid.W;
    p.y = Math.random() * this.grid.H;
    p.age = Math.floor(Math.random() * 80);
    return p;
  }

  sample(x, y) {
    const g = this.grid;
    const i = Math.round(x / g.step), j = Math.round(y / g.step);
    if (i < 0 || j < 0 || i >= g.gx || j >= g.gy) return null;
    const k = (j * g.gx + i) * 3;
    return g.data[k + 2] < 0 ? null : [g.data[k], g.data[k + 1], g.data[k + 2]];
  }

  loop() {
    if (!this.running) return;
    const ctx = this.ctx;
    const { W, H } = this.grid;
    // Fade the previous frame to leave trails.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.4;
    const k = 0.22; // pixels per frame per m/s: screen speed, the same at every zoom
    const byColor = new Map();
    for (const p of this.parts) {
      const w = this.sample(p.x, p.y);
      if (!w || p.age++ > 90) { this.spawn(p); p.age = 0; continue; }
      const nx = p.x + w[0] * k, ny = p.y - w[1] * k;
      const c = windColor(w[2]);
      let list = byColor.get(c);
      if (!list) byColor.set(c, (list = []));
      list.push(p.x, p.y, nx, ny);
      p.x = nx;
      p.y = ny;
      if (nx < 0 || ny < 0 || nx > W || ny > H) this.spawn(p);
    }
    for (const [c, l] of byColor) {
      ctx.strokeStyle = c;
      ctx.beginPath();
      for (let i = 0; i < l.length; i += 4) { ctx.moveTo(l[i], l[i + 1]); ctx.lineTo(l[i + 2], l[i + 3]); }
      ctx.stroke();
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }
}
