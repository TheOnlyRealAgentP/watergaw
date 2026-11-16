// Watergaw: pro-grade radar, free for everyone.
// App state, panels, timeline, inspector and sheets.

import { loadCore } from './core.js';
import { PRODUCTS, PRODUCT, TILT_HINT, productCode, Series, SweepStore, sampleSweep } from './nexrad.js';
import { BUILTIN, DOMAINS, HC_CLASSES, parsePal, paletteTexture, cssGradient, colorAt, rgbCss } from './palettes.js';
import { RadarLayer } from './radar-layer.js';
import { buildStyle, ANCHOR_RADAR } from './style.js';
import { Overlays, WARNING_TYPES, MRMS_LAYERS, MRMS_LEGEND, MOSAIC_LEGEND, GAUGE_COLORS, esc, mesoRank, hasTvs } from './overlays.js';
import { searchPlaces, summarize, intensityWord } from './places.js';
import * as U from './units.js';

const VERSION = '1.2.0';
const FORECAST_LEADS = [10, 20, 30, 40, 50, 60].map((m) => m * 60);
// Everyday mode shows these products with plain names.
const SIMPLE_PRODUCTS = [['REF', 'Radar'], ['PST', 'Rain totals']];
const STORE_KEY = 'watergaw.v1';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DEFAULTS = {
  site: null,
  mode: 'simple',
  forecast: true,
  notify: false,
  places: [],
  layout: 1,
  panels: [{ p: 'REF', t: 0 }, { p: 'SRV', t: 0 }, { p: 'CC', t: 0 }, { p: 'ZDR', t: 0 }],
  active: 0,
  frames: 12,
  speed: 1,
  smooth: true,
  opacity: 1,
  utc: false,
  basemap: 'dark',
  autoSite: false,
  units: { ...U.DEFAULT_UNITS },
  overlays: { warnings: true, watches: true, storms: true, reports: false, spc: false, rivers: false, rings: false, sites: true, satellite: false, lightning: false, tropical: false, mrms: 'off', mosaic: 'auto' },
  warningTypes: Object.fromEntries(WARNING_TYPES.map((w) => [w.key, w.on])),
  srm: { mode: 'auto', dir: 240, kt: 25 },
  filters: {},
  palettes: {},
  view: null,
  reportHours: 12,
};

// Highlight presets (value ranges in each product's native units).
const FILTER_PRESETS = {
  REF: [['Heavy rain and hail (≥ 50 dBZ)', 50, 95], ['Hail cores (≥ 60 dBZ)', 60, 95], ['Light precip only (< 30 dBZ)', -32, 30]],
  CC: [['Possible debris / hail (0.20–0.82)', 0.2, 0.82], ['Melting snow / mixed (0.82–0.95)', 0.82, 0.95]],
  ZDR: [['Big drops (≥ 3 dB)', 3, 8], ['Hail / tumbling (−1 to 0.5 dB)', -1, 0.5]],
  KDP: [['Very heavy rain (≥ 2 °/km)', 2, 10]],
  VIL: [['Large hail likely (≥ 45)', 45, 90]],
  ET: [['Tall updrafts (≥ 40 kft)', 40, 80]],
  PRECIP: [['Flooding rain (≥ 2 in)', 2, 30], ['≥ 1 in', 1, 30]],
};

class App {
  constructor() {
    this.state = this.loadState();
    this.panels = [];
    this.series = new Map();
    this.frameIndex = -1;
    this.live = true;
    this.playing = false;
    this.palCache = new Map();
    this.siteZoomThreshold = 5;
    this.userLoc = null;
    this.warnings = [];
    this.forecast = null;     // { base, frames: [{ key, time, sweep, lead }] }
    this.historyEnd = null;   // Unix seconds when looking at the past
    this.focus = null;        // { name, lat, lon, me }
  }

  get simple() { return this.state.mode === 'simple'; }

  // ======================================================== startup

  async start() {
    const [core, sites] = await Promise.all([loadCore(), fetch('data/sites.json').then((r) => r.json())]);
    this.core = core;
    this.sites = sites;
    this.store = new SweepStore();
    this.overlays = new Overlays(this);
    const s = this.state;
    this.site = sites.find((x) => x.id === s.site) || null;
    if (this.simple) { this.state.layout = 1; this.state.active = 0; }
    this.applyMode();
    this.buildChrome();
    this.buildPanels();
    this.overlays.start();
    this.updateSiteChip();
    if (this.site) this.loadAll(true);
    else this.showWelcome();
    setInterval(() => { if (!document.hidden) this.poll(); }, 30e3);
    setInterval(() => this.updateStatus(), 5e3);
    setInterval(() => this.renderFocus(), 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poll(); });
    this.registerSW();
  }

  // ======================================================== state

  loadState() {
    const s = structuredClone(DEFAULTS);
    try {
      // Settings saved before the app was renamed (Outflow) carry over.
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || localStorage.getItem('outflow.v1') || 'null');
      if (saved) {
        for (const [k, v] of Object.entries(saved)) {
          if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) s[k] = { ...s[k], ...v };
          else if (k in s) s[k] = v;
        }
      }
    } catch { /* private mode or bad data: defaults */ }
    // URL: #s=KTLX&p=REF.0,SRV.0&l=2&v=8.20/35.33/-97.28
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('s')) s.site = h.get('s').toUpperCase();
    if (h.get('p')) {
      h.get('p').split(',').slice(0, 4).forEach((x, i) => {
        const [p, t] = x.split('.');
        if (PRODUCT[p]) s.panels[i] = { p, t: Math.max(0, Math.min(5, +t || 0)) };
      });
    }
    if (h.get('l')) s.layout = [1, 2, 4].includes(+h.get('l')) ? +h.get('l') : s.layout;
    if (h.get('v')) {
      const [z, lat, lng] = h.get('v').split('/').map(Number);
      if ([z, lat, lng].every(Number.isFinite)) s.view = { zoom: z, lat, lng };
    }
    s.panels = s.panels.slice(0, 4);
    while (s.panels.length < 4) s.panels.push({ ...DEFAULTS.panels[s.panels.length] });
    s.active = Math.min(s.active, s.layout - 1);
    return s;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const s = this.state;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
      const v = s.view;
      const p = s.panels.slice(0, s.layout).map((x) => `${x.p}.${x.t}`).join(',');
      const parts = [];
      if (s.site) parts.push(`s=${s.site}`);
      parts.push(`p=${p}`);
      if (s.layout > 1) parts.push(`l=${s.layout}`);
      if (v) parts.push(`v=${v.zoom.toFixed(2)}/${v.lat.toFixed(4)}/${v.lng.toFixed(4)}`);
      history.replaceState(null, '', `#${parts.join('&')}`);
    }, 300);
  }

  // ======================================================== panels & maps

  get primaryMap() { return this.panels[0]?.map; }
  get activePanel() { return this.panels[this.state.active] || this.panels[0]; }

  buildPanels() {
    const host = $('#panels');
    for (const p of this.panels) { this.overlays.uninstall(p.map); p.map.remove(); }
    host.innerHTML = '';
    this.panels = [];
    const s = this.state;
    host.className = `panels layout-${s.layout}`;
    const view = s.view || (this.site ? { lng: this.site.lon, lat: this.site.lat, zoom: 7 } : { lng: -96.5, lat: 38.5, zoom: 3.6 });
    for (let i = 0; i < s.layout; i++) {
      const el = document.createElement('div');
      el.className = 'panel';
      el.innerHTML = `<div class="map"></div>
        <button class="panel-tag" type="button" aria-label="Change this panel's product"><b></b><span></span></button>
        <div class="crosshair" hidden></div>`;
      host.appendChild(el);
      const map = new maplibregl.Map({
        container: $('.map', el),
        style: buildStyle(s.basemap),
        center: [view.lng, view.lat],
        zoom: view.zoom,
        attributionControl: i === s.layout - 1 ? { compact: true } : false,
        dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
        renderWorldCopies: false, fadeDuration: 0, maxZoom: 15.5, minZoom: 2,
      });
      map.touchZoomRotate.disableRotation();
      map.once('load', () => el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
      const panel = { index: i, el, map, layer: null, tag: $('.panel-tag', el), cross: $('.crosshair', el), sweep: null };
      this.panels.push(panel);
      map.on('style.load', () => this.onStyleLoad(panel));
      map.on('move', (e) => this.onMove(panel, e));
      map.on('moveend', () => this.onMoveEnd(panel));
      map.on('click', (e) => this.onClick(panel, e));
      map.on('mousemove', (e) => this.onHover(panel, e));
      map.on('mouseout', () => this.hideCross());
      el.addEventListener('pointerdown', () => this.setActive(i), true);
      panel.tag.addEventListener('click', () => { this.setActive(i); this.openProducts(); });
    }
    this.updatePanelTags();
    this.applyPanelProducts();
    if (this.userLoc) this.placeUserMarkers();
  }

  onStyleLoad(panel) {
    const map = panel.map;
    panel.layer = new RadarLayer(`radar-${panel.index}`, this.core);
    map.addLayer(panel.layer, map.getLayer(ANCHOR_RADAR) ? ANCHOR_RADAR : undefined);
    this.overlays.install(map); // rasters go under the radar layer added above
    for (const id of ['ov-warn-fill', 'ov-storms', 'ov-lsr', 'ov-gauges', 'ov-sites', 'ov-watch', 'ov-mcd', 'ov-spc-fill']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    this.applyPaletteTo(panel);
    this.applyLayerOptions(panel);
    this.updateSiteVisibility();
    if (panel.sweep) panel.layer.setSweep(panel.sweep);
    else this.showFrame();
    if (panel.layer.failed) this.toast(panel.layer.failed);
  }

  onMove(panel, e) {
    if (this.syncing || !e.originalEvent && !e.watergawUser) return;
    this.syncing = true;
    const c = panel.map.getCenter();
    const z = panel.map.getZoom();
    for (const p of this.panels) if (p !== panel) p.map.jumpTo({ center: c, zoom: z });
    this.syncing = false;
  }

  onMoveEnd(panel) {
    if (panel !== this.panels[0]) return;
    const c = panel.map.getCenter();
    this.state.view = { lng: c.lng, lat: c.lat, zoom: panel.map.getZoom() };
    this.save();
    this.updateSiteVisibility();
    this.overlays.applyAll();
    if (this.state.overlays.rivers) this.overlays.loadGauges().catch(() => {});
    if (this.state.autoSite || (!this.site && panel.map.getZoom() >= 6)) this.maybeAutoSite();
  }

  updateSiteVisibility() {
    const z = this.primaryMap?.getZoom() ?? 8;
    const mode = this.state.overlays.mosaic;
    const show = mode !== 'auto' || z >= this.siteZoomThreshold;
    for (const p of this.panels) p.layer?.setVisible(show);
    this.mosaicView = mode === 'on' || (mode === 'auto' && z < this.siteZoomThreshold);
    this.updateStatus();
    this.renderLegend();
  }

  maybeAutoSite() {
    const c = this.primaryMap.getCenter();
    const near = this.nearestSites(c.lat, c.lng)[0];
    if (!near) return;
    if (!this.site) return this.setSite(near.site.id, { keepView: true });
    const cur = this.core.polar(this.site.lat, this.site.lon, 0, c.lat, c.lng).ground;
    if (near.site.id !== this.site.id && near.km < cur - 40) this.setSite(near.site.id, { keepView: true });
  }

  setActive(i) {
    if (i === this.state.active || i >= this.panels.length) return;
    this.state.active = i;
    this.save();
    this.updatePanelTags();
    this.renderProductStrip();
    this.renderLegend();
    this.rebuildTimeline();
  }

  setLayout(n) {
    if (n === this.state.layout) return;
    const c = this.primaryMap.getCenter();
    this.state.view = { lng: c.lng, lat: c.lat, zoom: this.primaryMap.getZoom() };
    this.state.layout = n;
    this.state.active = Math.min(this.state.active, n - 1);
    this.save();
    this.buildPanels();
    this.renderProductStrip();
    this.loadAll(false);
    $$('#layout-menu [data-layout]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.layout === n)));
  }

  // ======================================================== data

  seriesFor(code) {
    const id = `${this.site.l3}_${code}_${this.historyEnd || ''}`;
    let s = this.series.get(id);
    if (!s) { s = new Series(this.site.l3, code, this.historyEnd); this.series.set(id, s); }
    return s;
  }

  panelSeries(panel) {
    if (!this.site) return null;
    const cfg = this.state.panels[panel.index];
    return this.seriesFor(productCode(cfg.p, cfg.t));
  }

  /** Refresh the series every visible panel needs, then show frames. */
  async loadAll(first) {
    if (!this.site) return;
    const n = this.state.frames;
    const list = [...new Set(this.panels.map((p) => this.panelSeries(p)))];
    this.setBusy(true);
    await Promise.all(list.map((s) => (s.keys.length ? null : s.refresh(n))));
    this.setBusy(false);
    for (const s of list) if (s.error) this.toast(`Radar data: ${s.error}`);
    const master = this.panelSeries(this.activePanel);
    if (master && !master.keys.length) this.toast(`${this.site.id} has no recent ${PRODUCT[this.state.panels[this.state.active].p].name}. The radar may be down or in a mode that skips this product.`);
    this.rebuildTimeline(first);
    this.prefetch();
    this.updateNowcast();
    this.renderFocus();
  }

  async poll() {
    if (!this.site || this.historyEnd) return;
    const list = [...new Set(this.panels.map((p) => this.panelSeries(p)))];
    const changed = await Promise.all(list.map((s) => s.refresh(this.state.frames)));
    if (changed.some(Boolean)) {
      this.rebuildTimeline();
      this.prefetch();
    }
    this.updateNowcast();
    this.updateStatus();
  }

  prefetch() {
    // Newest first, so the live frame is ready soonest.
    const n = this.state.frames;
    for (const p of this.panels) {
      const s = this.panelSeries(p);
      if (!s) continue;
      for (const f of s.frames(n).reverse()) {
        this.store.get(f.key).then(() => this.onFrameLoaded(f.key), () => {});
      }
    }
  }

  onFrameLoaded(key) {
    const fr = this.timeline?.[this.frameIndex];
    if (!fr) return;
    for (const p of this.panels) if (p.wantKey === key) this.showFrame();
    this.renderTicks();
  }

  // ======================================================== timeline

  /** Forecast frames apply when the active panel shows lowest-tilt reflectivity. */
  forecastApplies() {
    const cfg = this.state.panels[this.state.active];
    return !!(this.forecast && this.state.forecast && !this.historyEnd && productCode(cfg.p, cfg.t) === 'N0B');
  }

  rebuildTimeline(jumpLive) {
    const master = this.site ? this.panelSeries(this.activePanel) : null;
    const real = master ? master.frames(this.state.frames) : [];
    const fc = this.forecastApplies() && real.length && this.forecast.base === real[real.length - 1].key ? this.forecast.frames : [];
    const frames = real.concat(fc);
    this.realCount = real.length;
    const prevTime = this.timeline?.[this.frameIndex]?.time;
    this.timeline = frames;
    if (!frames.length) { this.frameIndex = -1; this.renderTimeline(); this.showFrame(); return; }
    if (jumpLive || this.live || prevTime == null) this.frameIndex = real.length - 1;
    else {
      const i = frames.findIndex((f) => f.time >= prevTime);
      this.frameIndex = i < 0 ? real.length - 1 : i;
    }
    this.renderTimeline();
    this.showFrame();
  }

  /** Point each panel at the frame closest to (not after) the timeline time. */
  showFrame() {
    const fr = this.timeline?.[this.frameIndex];
    for (const p of this.panels) {
      if (!p.layer) continue;
      const s = this.panelSeries(p);
      if (!fr || !s) { p.wantKey = null; p.sweep = null; p.layer.setSweep(null); continue; }
      if (fr.sweep && s.code === 'N0B') {
        p.wantKey = fr.key;
        p.sweep = fr.sweep;
        p.layer.setSweep(fr.sweep);
        this.applyLayerOptions(p);
        continue;
      }
      const frames = s.frames(this.state.frames + 6);
      let pick = null;
      for (const f of frames) if (f.time <= fr.time + 90) pick = f;
      pick = pick || frames[0];
      if (!pick) { p.sweep = null; p.layer.setSweep(null); continue; }
      p.wantKey = pick.key;
      const pr = this.store.peek(pick.key) || this.store.get(pick.key);
      pr.then((sw) => {
        if (p.wantKey !== sw.key) return;
        p.sweep = sw;
        p.layer?.setSweep(sw);
        this.applyLayerOptions(p);
        this.updatePanelTags();
        if (p === this.activePanel) { this.renderTiltLabels(); this.updateStatus(); this.renderLegend(); }
        p.layer?.retain(new Set(s.frames(this.state.frames + 6).map((f) => f.key)));
      }, (e) => { if (p.wantKey === pick.key) this.toast(`Couldn’t decode ${pick.key}: ${e.message}`); });
    }
    this.renderTimeLabel();
    this.updateStatus();
    this.updatePanelTags();
  }

  step(d) {
    if (!this.timeline?.length) return;
    this.frameIndex = (this.frameIndex + d + this.timeline.length) % this.timeline.length;
    this.live = this.frameIndex === this.realCount - 1;
    $('#scrub').value = this.frameIndex;
    this.showFrame();
  }

  togglePlay(force) {
    this.playing = force ?? !this.playing;
    $('#btn-play').classList.toggle('on', this.playing);
    $('#btn-play').setAttribute('aria-label', this.playing ? 'Pause' : 'Play loop');
    clearTimeout(this.playTimer);
    if (this.playing) this.tick();
  }

  tick() {
    if (!this.playing) return;
    const last = this.frameIndex === this.timeline.length - 1;
    const base = 260 / this.state.speed;
    this.playTimer = setTimeout(() => {
      // Wait for the next frame to finish decoding instead of skipping it.
      const next = this.timeline[(this.frameIndex + 1) % this.timeline.length];
      const ready = next && this.store.peek(next.key);
      Promise.race([ready || Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]).then(() => {
        if (!this.playing) return;
        this.step(1);
        this.tick();
      });
    }, last ? Math.max(1200, base * 4) : base);
  }

  goLive() {
    this.togglePlay(false);
    this.live = true;
    if (this.timeline?.length) { this.frameIndex = this.realCount - 1; $('#scrub').value = this.frameIndex; }
    this.poll();
    this.showFrame();
  }

  renderTimeline() {
    const n = this.timeline?.length || 0;
    const scrub = $('#scrub');
    scrub.max = Math.max(0, n - 1);
    scrub.value = Math.max(0, this.frameIndex);
    scrub.disabled = n < 2;
    this.renderTicks();
    this.renderTimeLabel();
  }

  renderTicks() {
    const el = $('#ticks');
    const fr = this.timeline || [];
    el.innerHTML = fr.map((f, i) => `<i class="${f.sweep ? 'fc' : this.store.peek(f.key) ? 'ok' : ''} ${i === this.frameIndex ? 'cur' : ''}"></i>`).join('');
  }

  renderTimeLabel() {
    const fr = this.timeline?.[this.frameIndex];
    const sw = this.activePanel?.sweep;
    const t = fr?.sweep ? fr.sweep.meta.scan_time : sw && fr && Math.abs(sw.meta.vol_time - fr.time) < 600 ? sw.meta.scan_time : fr?.time;
    $('#frame-time').textContent = t ? U.clock(t, this.state.utc) : '--:--';
    $('#frame-time').classList.toggle('fc', !!fr?.sweep);
    const banner = $('#fc-banner');
    banner.hidden = !fr?.sweep;
    if (fr?.sweep) banner.textContent = `Forecast · +${fr.lead / 60} min · where today's storms are heading`;
    $('#btn-live').classList.toggle('on', !!this.timeline?.length && this.live && !this.playing);
    $$('#ticks i').forEach((x, i) => x.classList.toggle('cur', i === this.frameIndex));
  }

  // ======================================================== products, palettes, options

  palette(name) {
    const custom = this.state.palettes[name];
    const key = `${name}:${custom ? custom.length : 0}`;
    let p = this.palCache.get(key);
    if (!p) {
      try { p = parsePal(custom || BUILTIN[name]); } catch { p = parsePal(BUILTIN[name]); }
      this.palCache.set(key, p);
    }
    return p;
  }

  applyPaletteTo(panel) {
    if (!panel.layer) return;
    const prod = PRODUCT[this.state.panels[panel.index].p];
    const pal = this.palette(prod.palette);
    const dom = DOMAINS[prod.palette];
    panel.layer.setPalette(paletteTexture(pal, dom[0], dom[1]), dom, pal.rf, prod.categorical);
  }

  stormVector() {
    const s = this.state.srm;
    if (s.mode === 'auto') {
      const m = this.overlays.meanMotion();
      if (m) return [m.u, m.v, 'auto'];
    }
    const to = ((s.dir + 180) * Math.PI) / 180;
    const ms = s.kt / 1.943844;
    return [ms * Math.sin(to), ms * Math.cos(to), 'manual'];
  }

  applyLayerOptions(panel) {
    if (!panel.layer) return;
    const cfg = this.state.panels[panel.index];
    const prod = PRODUCT[cfg.p];
    const f = this.state.filters[cfg.p];
    const storm = prod.srv ? this.stormVector() : [0, 0];
    panel.layer.setOptions({ smooth: this.state.smooth, opacity: this.state.opacity, storm: [storm[0], storm[1]], filter: f || [0, 0] });
  }

  applyPanelProducts() {
    for (const p of this.panels) { this.applyPaletteTo(p); this.applyLayerOptions(p); }
    this.updatePanelTags();
    this.renderProductStrip();
    this.renderLegend();
  }

  setProduct(id, tilt) {
    const cfg = this.state.panels[this.state.active];
    const prod = PRODUCT[id];
    cfg.p = id;
    if (tilt != null) cfg.t = tilt;
    cfg.t = Math.min(cfg.t, prod.codes.length - 1);
    this.save();
    const panel = this.activePanel;
    panel.sweep = null;
    this.applyPaletteTo(panel);
    this.applyLayerOptions(panel);
    this.updatePanelTags();
    this.renderProductStrip();
    this.renderLegend();
    this.loadAll(false);
  }

  setTilt(t) {
    const cfg = this.state.panels[this.state.active];
    if (PRODUCT[cfg.p].volume) return;
    this.setProduct(cfg.p, Math.max(0, Math.min(5, t)));
  }

  updatePanelTags() {
    for (const p of this.panels) {
      const cfg = this.state.panels[p.index];
      const prod = PRODUCT[cfg.p];
      const el = p.sweep && !prod.volume ? `${p.sweep.meta.elevation.toFixed(1)}°` : prod.volume ? '' : TILT_HINT[cfg.t];
      $('b', p.tag).textContent = prod.short;
      const when = p.sweep ? (p.sweep.meta.forecast ? `Forecast +${p.sweep.meta.forecast / 60}m` : U.clock(p.sweep.meta.scan_time, this.state.utc)) : '';
      $('span', p.tag).textContent = [el, when].filter(Boolean).join(' · ');
      p.el.classList.toggle('active', p.index === this.state.active && this.state.layout > 1);
      p.tag.hidden = this.state.layout === 1;
    }
    const cfg = this.state.panels[this.state.active];
    const prod = PRODUCT[cfg.p];
    $('#prod-name').textContent = prod.short;
    $('#prod-tilt').textContent = prod.volume ? '' : (this.activePanel?.sweep ? `${this.activePanel.sweep.meta.elevation.toFixed(1)}°` : TILT_HINT[cfg.t]);
  }

  // ======================================================== site

  nearestSites(lat, lng) {
    return this.sites.map((site) => ({ site, km: this.core.polar(lat, lng, 0, site.lat, site.lon).ground })).sort((a, b) => a.km - b.km);
  }

  setSite(id, { keepView = false } = {}) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    this.site = site;
    this.state.site = id;
    this.save();
    this.live = true;
    for (const p of this.panels) { p.sweep = null; p.layer?.setSweep(null); }
    this.updateSiteChip();
    this.overlays.setSites();
    this.overlays.setRings();
    this.overlays.filterStorms();
    if (!keepView) {
      const z = Math.max(this.primaryMap.getZoom(), 6.6);
      this.primaryMap.flyTo({ center: [site.lon, site.lat], zoom: z, duration: 900 });
      this.primaryMap.once('moveend', () => this.syncAll());
    }
    $('#welcome')?.remove();
    this.loadAll(true);
  }

  syncAll() {
    const m = this.primaryMap;
    for (const p of this.panels.slice(1)) p.map.jumpTo({ center: m.getCenter(), zoom: m.getZoom() });
  }

  updateSiteChip() {
    $('#site-id').textContent = this.site ? this.site.id : 'Radar';
    $('#site-name').textContent = this.site ? this.site.name : 'Pick a site';
  }

  // ======================================================== status

  setBusy(on) {
    $('#status').classList.toggle('busy', on);
  }

  updateStatus() {
    const el = $('#status');
    const txt = $('#age');
    if (this.mosaicView && this.overlays?.mosaicTime && (!this.site || (this.primaryMap?.getZoom() ?? 9) < this.siteZoomThreshold)) {
      txt.textContent = `Mosaic ${U.clock(this.overlays.mosaicTime, this.state.utc)}`;
      el.dataset.age = ageClass(this.overlays.mosaicTime);
      return;
    }
    const s = this.site && this.panelSeries(this.activePanel);
    const last = s?.keys.length ? s.frames(1)[0] : null;
    const sw = this.activePanel?.sweep;
    const t = sw && last && sw.key === last.key ? sw.meta.scan_time : last?.time;
    if (!t) { txt.textContent = this.site ? 'Loading…' : 'No radar'; el.dataset.age = 'none'; return; }
    txt.textContent = U.ago(t);
    el.dataset.age = ageClass(t);
  }

  onMosaicTime() { this.updateStatus(); }

  // ======================================================== legend

  renderLegend() {
    const el = $('#legend');
    if (!el) return;
    const o = this.state.overlays;
    const parts = [];
    if (this.mosaicView && (!this.site || (this.primaryMap?.getZoom() ?? 9) < this.siteZoomThreshold)) {
      parts.push(stepLegend('National mosaic · dBZ', MOSAIC_LEGEND.map(([v, c]) => [c, String(v)])));
    } else if (this.activePanel) {
      parts.push(this.productLegend());
    }
    if (o.lightning) {
      const ltg = ['#ffec78', '#ffd600', '#ff7800', '#ff0000', '#cc0066', '#ff00ff', '#4000c0', '#00c7ff', '#00ff00'];
      parts.push(`<div class="lg"><div class="lg-title">Lightning · last 15 minutes</div><div class="lg-bar" style="background:linear-gradient(90deg, ${ltg.join(', ')})"></div>
        <div class="lg-ends"><span>Fewer strikes</span><span>More strikes</span></div></div>`);
    }
    if (MRMS_LAYERS[o.mrms]) {
      parts.push(stepLegend(`MRMS rainfall · ${MRMS_LAYERS[o.mrms][1]} · ${this.state.units.rain}`,
        MRMS_LEGEND.map(([v, c]) => [c, this.state.units.rain === 'mm' ? U.fmt(v * 25.4) : String(v)])));
    }
    el.innerHTML = parts.join('');
  }

  productLegend() {
    const cfg = this.state.panels[this.state.active];
    const prod = PRODUCT[cfg.p];
    const pal = this.palette(prod.palette);
    const u = this.state.units;
    const f = this.state.filters[cfg.p];
    const filt = f ? ` <button class="chip-x" data-act="clear-filter" title="Stop highlighting">highlight ${this.fmtValue(prod, f[0], true)}–${this.fmtValue(prod, f[1], true)} ×</button>` : '';
    if (prod.categorical) {
      const items = HC_CLASSES.map((c, i) => c && [rgbCss(colorAt(pal, i)), c[0], c[1]]).filter(Boolean);
      return `<div class="lg"><div class="lg-title">${prod.name}${filt}</div><div class="lg-classes">${items.map(([c, a, n]) => `<span title="${n}"><i style="background:${c}"></i>${a}</span>`).join('')}</div></div>`;
    }
    if (prod.kind === 'precip') {
      const vals = [0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 10];
      return stepLegend(`${prod.name} · ${u.rain}${filt}`, vals.map((v) => [rgbCss(colorAt(pal, v)), u.rain === 'mm' ? U.fmt(v * 25.4) : String(v)]));
    }
    let lo, hi, ticks, unit;
    switch (prod.kind) {
      case 'ref': lo = -10; hi = 80; unit = 'dBZ'; ticks = [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80].map((v) => [v, v]); break;
      case 'vel': {
        lo = -64; hi = 64;
        const sp = U.speed(1, u.speed);
        const step = { kt: 25, mph: 30, ms: 15, kmh: 50 }[u.speed];
        unit = sp.unit;
        ticks = [];
        for (let v = -Math.floor(64 * sp.v / step) * step; v <= 64 * sp.v; v += step) ticks.push([v / sp.v, v]);
        break;
      }
      case 'cc': lo = 0.2; hi = 1.05; unit = ''; ticks = [0.2, 0.4, 0.6, 0.8, 0.9, 1].map((v) => [v, v]); break;
      case 'zdr': lo = -4; hi = 8; unit = 'dB'; ticks = [-4, -2, 0, 2, 4, 6, 8].map((v) => [v, v]); break;
      case 'kdp': lo = -2; hi = 7; unit = '°/km'; ticks = [-2, 0, 1, 2, 3, 5, 7].map((v) => [v, v]); break;
      case 'vil': lo = 0; hi = 80; unit = 'kg/m²'; ticks = [0, 10, 20, 30, 40, 50, 60, 70, 80].map((v) => [v, v]); break;
      case 'et': {
        lo = 0; hi = 70;
        if (u.height === 'ft') { unit = 'kft'; ticks = [0, 10, 20, 30, 40, 50, 60, 70].map((v) => [v, v]); }
        else { unit = 'km'; ticks = [0, 3, 6, 9, 12, 15, 18, 21].map((v) => [v / 0.3048, v]); }
        break;
      }
      default: lo = 0; hi = 1; unit = ''; ticks = [];
    }
    if (this.simple && prod.kind === 'ref') {
      // Plain words in equal blocks so the labels always fit, even on small phones.
      return stepLegend(`Rain and storms${filt}`, [[25, 'Light'], [35, 'Moderate'], [45, 'Heavy'], [55, 'Very heavy'], [65, 'Hail']].map(([v, l]) => [rgbCss(colorAt(pal, v)), l]));
    }
    const grad = cssGradient(pal, lo, hi);
    const pos = (v) => ((v - lo) / (hi - lo)) * 100;
    const srv = prod.srv ? this.srvLabel() : '';
    const title = this.simple && prod.kind === 'ref' ? 'Rain and storms' : `${prod.name}${unit ? ` · ${unit}` : ''}`;
    return `<div class="lg"><div class="lg-title">${title}${srv}${filt}</div>
      <div class="lg-bar" style="background:${grad}"></div>
      <div class="lg-ticks">${ticks.filter(([v]) => v >= lo && v <= hi).map(([v, l]) => `<span style="left:${pos(v)}%">${l}</span>`).join('')}</div></div>`;
  }

  srvLabel() {
    const [u, v, mode] = this.stormVector();
    const ms = Math.hypot(u, v);
    const to = (Math.atan2(u, v) * 180) / Math.PI;
    const from = Math.round((to + 180 + 360) % 360);
    return ` <span class="lg-note">motion ${from}° @ ${U.fmtU(U.speed(ms, this.state.units.speed))} (${mode})</span>`;
  }

  fmtValue(prod, v, short) {
    const u = this.state.units;
    switch (prod.kind) {
      case 'ref': return short ? U.fmt(v) : this.simple ? `${intensityWord(v) || 'Very light'} (${U.fmt(v)} dBZ)` : `${U.fmt(v, 1)} dBZ`;
      case 'vel': { const s = U.speed(v, u.speed); return short ? U.fmt(s.v) : `${U.fmt(Math.abs(s.v))} ${s.unit} ${v < 0 ? 'toward' : v > 0 ? 'away' : ''}`.trim(); }
      case 'cc': return U.fmt(v, short ? 2 : 3);
      case 'zdr': return `${U.fmt(v, short ? 1 : 2)}${short ? '' : ' dB'}`;
      case 'kdp': return `${U.fmt(v, short ? 1 : 2)}${short ? '' : ' °/km'}`;
      case 'hc': { const c = HC_CLASSES[Math.round(v)]; return c ? (short ? c[0] : c[1]) : '—'; }
      case 'vil': return `${U.fmt(v, short ? 0 : 1)}${short ? '' : ' kg/m²'}`;
      case 'et': return short ? U.fmt(v) : U.fmtU(U.height(v * 0.3048, u.height));
      case 'precip': return short ? U.fmt(U.rain(v, u.rain).v, 1) : U.fmtU(U.rain(v, u.rain), u.rain === 'mm' ? 0 : 2);
      default: return U.fmt(v, 2);
    }
  }

  // ======================================================== inspector

  sampleAll(lngLat) {
    const out = [];
    for (const p of this.panels) {
      const sw = p.sweep;
      const cfg = this.state.panels[p.index];
      const prod = PRODUCT[cfg.p];
      if (!sw) { out.push({ prod, text: 'No data' }); continue; }
      const m = sw.meta;
      const pol = this.core.polar(m.lat, m.lon, m.elevation, lngLat.lat, lngLat.lng);
      const r = sampleSweep(sw, pol.az, pol.slant);
      let text;
      if (r.flag === 2) text = 'Range folded';
      else if (r.flag !== 0) text = pol.slant > m.first_gate_km + m.gates * m.gate_km ? 'Out of range' : 'No echo';
      else {
        let v = r.value;
        if (prod.srv) { const [su, sv] = this.stormVector(); const a = (pol.az * Math.PI) / 180; v -= su * Math.sin(a) + sv * Math.cos(a); }
        text = this.fmtValue(prod, v);
      }
      out.push({ prod, text, pol, meta: m });
    }
    return out;
  }

  onHover(panel, e) {
    if (matchMedia('(hover: none)').matches) return;
    this.showCross(e.lngLat);
    const hud = $('#hud');
    if (!this.site || !panel.sweep) { hud.hidden = true; return; }
    const vals = this.sampleAll(e.lngLat);
    const first = vals.find((v) => v.pol);
    const U2 = this.state.units;
    hud.hidden = false;
    hud.innerHTML = vals.map((v) => `<div><b>${v.prod.short}</b> ${esc(v.text)}</div>`).join('') +
      (first ? `<div class="sub">${Math.round(first.pol.az)}° · ${U.fmtU(U.distance(first.pol.ground, U2.distance), 1)} · beam ${U.fmtU(U.height(first.pol.height, U2.height))} up</div>` : '');
    const r = panel.el.getBoundingClientRect();
    const x = e.point.x + r.left, y = e.point.y + r.top;
    const w = hud.offsetWidth, h = hud.offsetHeight;
    hud.style.left = `${Math.min(x + 16, innerWidth - w - 8)}px`;
    hud.style.top = `${Math.min(y + 16, innerHeight - h - 8)}px`;
  }

  showCross(lngLat) {
    if (this.panels.length < 2) return;
    for (const p of this.panels) {
      const pt = p.map.project(lngLat);
      p.cross.hidden = false;
      p.cross.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    }
  }

  hideCross() {
    for (const p of this.panels) p.cross.hidden = true;
    $('#hud').hidden = true;
  }

  onClick(panel, e) {
    const map = panel.map;
    const pad = 8;
    const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const layers = ['ov-trop-pts', 'ov-sites', 'ov-storms', 'ov-lsr', 'ov-gauges'].filter((id) => map.getLayer(id));
    const hit = map.queryRenderedFeatures(box, { layers })[0];
    if (hit) {
      const p = hit.properties;
      if (p.kind === 'site') return this.setSite(p.id);
      if (p.kind === 'gauge') return this.openGauge(p);
      const d = this.overlays.describe(hit);
      if (d) return this.openSheet(d.title, d.html, d.color);
    }
    this.inspectAt(panel, e.lngLat);
  }

  inspectAt(panel, lngLat) {
    const map = panel.map;
    const pt = map.project(lngLat);
    const areaLayers = ['ov-warn-fill', 'ov-trop-ww', 'ov-trop-cone', 'ov-trop-outlook', 'ov-watch', 'ov-mcd', 'ov-spc-fill'].filter((id) => map.getLayer(id));
    const areas = map.queryRenderedFeatures(pt, { layers: areaLayers });
    const seen = new Set();
    const chips = [];
    this.inspectFeatures = [];
    for (const f of areas) {
      const k = `${f.properties.kind}:${f.properties.nwsId || f.properties.label || f.properties.LABEL || f.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const d = this.overlays.describe(f);
      if (!d) continue;
      this.inspectFeatures.push(d);
      chips.push(`<button class="chip warn-chip" data-i="${this.inspectFeatures.length - 1}" style="--c:${d.color}">${esc(d.title)}</button>`);
    }
    const vals = this.site ? this.sampleAll(lngLat) : [];
    const first = vals.find((v) => v.pol);
    const u = this.state.units;
    const card = $('#inspect');
    let geo = '';
    if (first) {
      const beamW = first.pol.slant * (0.95 * Math.PI / 180);
      geo = `<div class="sub">${Math.round(first.pol.az)}° ${U.compass(first.pol.az)} · ${U.fmtU(U.distance(first.pol.ground, u.distance), 1)} from ${this.site.id}<br>
        Beam centre ${U.fmtU(U.height(first.pol.height, u.height))} above the radar, ${U.fmtU(U.distance(beamW, u.distance), 1)} wide</div>`;
    }
    card.innerHTML = `<button class="icon-btn close" data-act="close-inspect" aria-label="Close">${ICON.x}</button>
      <div class="vals">${vals.map((v) => `<div><b>${v.prod.short}</b><span>${esc(v.text)}</span></div>`).join('') || '<div><span>No radar loaded here</span></div>'}</div>
      ${geo}<div class="sub coords">${lngLat.lat.toFixed(4)}, ${lngLat.lng.toFixed(4)}</div>
      ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}`;
    card.hidden = false;
    this.placePin(lngLat);
  }

  placePin(lngLat) {
    for (const p of this.panels) {
      if (!p.pin) {
        const el = document.createElement('div');
        el.className = 'pin';
        p.pin = new maplibregl.Marker({ element: el });
      }
      p.pin.setLngLat(lngLat).addTo(p.map);
    }
  }

  closeInspect() {
    $('#inspect').hidden = true;
    for (const p of this.panels) p.pin?.remove();
  }

  // ======================================================== safety alerts

  onWarnings(feats) {
    this.warnings = feats;
    this.checkAlerts();
    const near = this.site ? feats.filter((f) => this.featureNear(f, this.site, 500)) : feats;
    const n = near.filter((f) => ['TOR', 'SVR', 'FFW', 'EWW', 'SQW'].includes(f.properties.key)).length;
    $('#alert-count').textContent = n ? String(n) : '';
    $('#alert-count').hidden = !n;
    this.checkArrivals();
    if (!$('#sheet').hidden && $('#sheet').dataset.kind === 'alerts') this.openAlerts();
  }

  onStorms() {
    for (const p of this.panels) if (PRODUCT[this.state.panels[p.index].p].srv) this.applyLayerOptions(p);
    this.renderLegend();
    this.checkArrivals();
  }

  featureNear(f, site, km) {
    const c = bboxCenter(f.geometry);
    return c && this.core.polar(site.lat, site.lon, 0, c[1], c[0]).ground < km;
  }

  checkArrivals() {
    this.renderFocus();
  }

  // ======================================================== nowcast

  /** Extrapolate the latest lowest-tilt reflectivity an hour ahead (Rust, in a worker). */
  async updateNowcast() {
    if (!this.state.forecast || this.historyEnd || !this.site) { if (this.forecast) { this.forecast = null; this.rebuildTimeline(); } return; }
    const s = this.seriesFor('N0B');
    if (!s.keys.length) await s.refresh(this.state.frames);
    const fr = s.frames(8);
    if (fr.length < 2) return;
    const last = fr[fr.length - 1];
    if (this.forecast?.base === last.key || this.nowcastBusy === last.key) return;
    this.nowcastBusy = last.key;
    try {
      const newer = await this.store.get(last.key);
      let olderKey = fr[fr.length - 2].key;
      for (let i = fr.length - 2; i >= 0; i--) if (last.time - fr[i].time >= 240) { olderKey = fr[i].key; break; }
      const older = await this.store.get(olderKey);
      const mm = this.overlays.meanMotion();
      const fallback = mm ? [mm.u / 1000, mm.v / 1000] : [0, 0];
      const out = await this.store.nowcast(older, newer, FORECAST_LEADS, fallback);
      this.forecast = {
        base: last.key,
        summary: out.summary,
        frames: out.frames.map((codes, i) => {
          const lead = FORECAST_LEADS[i];
          const key = `${last.key}#+${lead / 60}`;
          const sweep = { key, time: last.time + lead, codes, lut: newer.lut, flags: newer.flags, meta: { ...newer.meta, scan_time: newer.meta.scan_time + lead, forecast: lead } };
          return { key, time: last.time + lead, lead, sweep };
        }),
      };
      this.rebuildTimeline();
      this.renderFocus();
      this.checkAlerts();
    } catch (e) {
      console.warn('Nowcast failed:', e);
    } finally {
      this.nowcastBusy = null;
    }
  }

  // ======================================================== places & the "here" card

  latestSweep(code) {
    if (!this.site) return null;
    const f = this.seriesFor(code).frames(1)[0];
    return f ? this.store.peek(f.key) : null;
  }

  async renderFocus() {
    const card = $('#now');
    if (!card) return;
    const f = this.focus;
    if (!f) {
      card.hidden = !this.simple || !!$('#welcome');
      card.className = 'now prompt';
      card.innerHTML = `<div class="now-head"><b>What's coming?</b></div>
        <p class="now-sub">See rain, storms and warnings for any place.</p>
        <div class="now-actions"><button class="btn primary small" data-act="locate">${ICON.locate}<span>My location</span></button>
        <button class="btn small" data-act="search">${ICON.search}<span>Search a place</span></button></div>`;
      return;
    }
    const nowP = this.latestSweep('N0B');
    const hcP = this.latestSweep('N0H');
    const [now, hc] = await Promise.all([nowP ? nowP.catch(() => null) : null, hcP ? hcP.catch(() => null) : null]);
    if (this.site && !hcP) this.seriesFor('N0H').refresh(2).then(() => { const k = this.seriesFor('N0H').frames(1)[0]; if (k) this.store.get(k.key).then(() => this.renderFocus(), () => {}); });
    const warnings = (this.warnings || []).filter((w) => pointInGeom([f.lon, f.lat], w.geometry));
    const ctx = {
      core: this.core, now, hc, utc: this.state.utc, siteId: this.site?.id || 'the radar',
      forecast: this.forecast && this.state.forecast ? this.forecast.frames.map((x) => ({ lead: x.lead, sweep: x.sweep })) : [],
      warnings, arrivals: this.overlays.arrivals(f.lon, f.lat),
    };
    const sum = now ? summarize(f.lat, f.lon, ctx) : { level: warnings.length ? 'danger' : 'far', headline: warnings.length ? warnings[0].properties.event : (this.site ? 'Loading radar…' : 'Pick a radar to see rain here'), lines: [], bars: [] };
    this.focusLines = sum.lines;
    const saved = this.state.places.some((p) => Math.abs(p.lat - f.lat) < 1e-4 && Math.abs(p.lon - f.lon) < 1e-4);
    const pal = this.palette('REF');
    const bars = sum.bars.map((b) => {
      const c = b.v >= 15 ? rgbCss(colorAt(pal, b.v)) : 'var(--line-strong)';
      const h = b.v >= 15 ? Math.min(100, 25 + (b.v - 15) * 1.6) : 8;
      return `<span class="bar ${b.fc ? 'fc' : ''}" title="${b.v >= 20 ? intensityWord(b.v) : 'Dry'}"><i style="height:${h}%;background:${c}"></i><small>${b.label}</small></span>`;
    }).join('');
    card.hidden = false;
    card.className = `now lvl-${sum.level}`;
    card.innerHTML = `<div class="now-head">${f.me ? ICON.locate : ICON.pin}<b>${esc(f.name)}</b>
        ${f.me ? '' : `<button class="icon-btn tiny" data-act="save-place" aria-label="${saved ? 'Remove from my places' : 'Save to my places'}" title="${saved ? 'Saved' : 'Save place'}">${saved ? ICON.starOn : ICON.star}</button>`}
        <button class="icon-btn tiny" data-act="clear-focus" aria-label="Close">${ICON.x}</button></div>
      <p class="now-headline">${esc(sum.headline)}</p>
      ${bars ? `<div class="bars" aria-label="Next hour">${bars}</div>` : ''}
      ${sum.lines.map((l, i) => `<button class="now-line ${l.cls}" data-line="${i}">${esc(l.text)}</button>`).join('')}`;
  }

  focusOn(place, { fly = true } = {}) {
    this.focus = place;
    $('#welcome')?.remove();
    if (!place.me) this.placeMarker(place);
    const near = this.nearestSites(place.lat, place.lon)[0];
    if (near && (!this.site || near.site.id !== this.site.id)) {
      const cur = this.site ? this.core.polar(this.site.lat, this.site.lon, 0, place.lat, place.lon).ground : Infinity;
      if (cur > 180 || near.km < cur - 30) this.setSite(near.site.id, { keepView: true });
    }
    if (fly) {
      this.primaryMap.flyTo({ center: [place.lon, place.lat], zoom: Math.max(this.primaryMap.getZoom(), 8.5), duration: 900 });
      this.primaryMap.once('moveend', () => this.syncAll());
    }
    this.renderFocus();
  }

  placeMarker(place) {
    for (const p of this.panels) {
      if (!p.placePin) {
        const el = document.createElement('div');
        el.className = 'place-pin';
        p.placePin = new maplibregl.Marker({ element: el, anchor: 'bottom' });
      }
      p.placePin.setLngLat([place.lon, place.lat]).addTo(p.map);
    }
  }

  clearFocus() {
    this.focus = null;
    for (const p of this.panels) p.placePin?.remove();
    this.renderFocus();
  }

  toggleSave() {
    const f = this.focus;
    if (!f) return;
    const i = this.state.places.findIndex((p) => Math.abs(p.lat - f.lat) < 1e-4 && Math.abs(p.lon - f.lon) < 1e-4);
    if (i >= 0) { this.state.places.splice(i, 1); this.toast(`Removed ${f.name}`); }
    else { this.state.places.push({ name: f.name, lat: f.lat, lon: f.lon }); this.toast(`Saved ${f.name} to My places`); }
    this.save();
    this.renderFocus();
  }

  openSearch() {
    const body = this.openSheet('Find a place', `
      <div class="sheet-tools"><input type="search" id="place-q" placeholder="City, address or ZIP code" autocomplete="off" enterkeyhint="search">
      <button class="btn" data-act="locate">${ICON.locate}<span>Me</span></button></div>
      <div class="site-list" id="place-results"></div>
      ${this.state.places.length ? `<h4>My places</h4><div class="site-list" id="my-places">${this.state.places.map((p, i) => {
        const warn = (this.warnings || []).find((w) => pointInGeom([p.lon, p.lat], w.geometry));
        return `<div class="place-row"><button type="button" class="site-row" data-saved="${i}"><b>${ICON.pin}</b><span>${esc(p.name)}</span>
          <small class="${warn ? 'hot' : ''}">${warn ? esc(warn.properties.event) : ''}</small></button>
          <button class="icon-btn tiny" data-unsave="${i}" aria-label="Remove ${esc(p.name)}">${ICON.x}</button></div>`;
      }).join('')}</div>` : '<p class="note">Tip: save places (home, school, family) with the star to check them in one tap.</p>'}`, null, 'search');
    const input = $('#place-q', body);
    let timer;
    let results = [];
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value;
        try {
          results = await searchPlaces(q, this.primaryMap.getCenter());
        } catch { results = []; }
        if (input.value !== q) return;
        $('#place-results', body).innerHTML = results.map((r, i) => `<button type="button" class="site-row" data-res="${i}"><b>${ICON.pin}</b><span>${esc(r.name)}<small>${esc(r.detail)}</small></span><small></small></button>`).join('')
          || (q.trim().length > 1 ? '<p class="note">No matches yet. Try a city and state.</p>' : '');
      }, 250);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && results[0]) { this.closeSheet(); this.focusOn(results[0]); } });
    body.addEventListener('click', (e) => {
      const r = e.target.closest('[data-res]');
      if (r) { this.closeSheet(); return this.focusOn(results[+r.dataset.res]); }
      const sv = e.target.closest('[data-saved]');
      if (sv) { this.closeSheet(); return this.focusOn(this.state.places[+sv.dataset.saved]); }
      const un = e.target.closest('[data-unsave]');
      if (un) { this.state.places.splice(+un.dataset.unsave, 1); this.save(); this.openSearch(); }
    });
    setTimeout(() => input.focus(), 50);
  }

  // ======================================================== alerts

  async enableAlerts(on) {
    if (on) {
      if (!('Notification' in window)) { this.toast('This browser can’t show notifications.'); return false; }
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') { this.toast('Notifications are blocked for this site. Allow them in your browser settings.'); return false; }
    }
    this.state.notify = on;
    this.save();
    if (on) { this.toast('Alerts on'); this.checkAlerts(); }
    return true;
  }

  notifiedSet() {
    if (!this.notified) {
      try { this.notified = new Map(JSON.parse(localStorage.getItem('watergaw.notified') || '[]')); } catch { this.notified = new Map(); }
    }
    return this.notified;
  }

  async notify(key, title, body) {
    const seen = this.notifiedSet();
    if (seen.has(key)) return;
    seen.set(key, Date.now());
    const cutoff = Date.now() - 2 * 86400e3;
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
    try { localStorage.setItem('watergaw.notified', JSON.stringify([...seen])); } catch { /* ignore */ }
    this.toast(`${title}: ${body}`);
    const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: key };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch { /* toast already shown */ }
  }

  /** Warnings and incoming rain for your location and saved places. */
  checkAlerts() {
    if (!this.state.notify || this.historyEnd) return;
    const targets = [...(this.userLoc ? [{ name: 'your location', lat: this.userLoc.lat, lon: this.userLoc.lng }] : []), ...this.state.places];
    for (const t of targets) {
      for (const w of this.warnings || []) {
        if (!['TOR', 'SVR', 'FFW', 'EWW', 'SQW', 'DSW', 'SMW'].includes(w.properties.key)) continue;
        if (!pointInGeom([t.lon, t.lat], w.geometry)) continue;
        const p = w.properties;
        const name = p.emph === 2 && p.key === 'TOR' ? 'TORNADO EMERGENCY' : p.event;
        this.notify(`${p.nwsId}|${t.name}`, name, `For ${t.name} until ${U.clock(Date.parse(p.expires) / 1000, this.state.utc)}`);
      }
    }
    // Incoming rain (needs the current radar's nowcast).
    const nowP = this.latestSweep('N0B');
    if (!nowP || !this.forecast) return;
    nowP.then((now) => {
      for (const t of targets) {
        const sum = summarize(t.lat, t.lon, { core: this.core, now, hc: null, utc: this.state.utc, siteId: this.site.id, warnings: [], arrivals: [],
          forecast: this.forecast.frames.map((x) => ({ lead: x.lead, sweep: x.sweep })) });
        if (sum.level !== 'soon') continue;
        const first = sum.bars.slice(1).find((b) => b.v >= 20);
        if (!first || first.t - Date.now() / 1000 > 35 * 60) continue;
        this.notify(`rain|${t.name}|${Math.floor(Date.now() / 3 / 3600e3)}`, `Rain coming to ${t.name}`, sum.headline);
      }
    }, () => {});
  }

  // ======================================================== history

  setHistory(t) {
    this.historyEnd = t && t < Date.now() / 1000 - 300 ? Math.floor(t) : null;
    this.live = true;
    this.forecast = null;
    for (const p of this.panels) { p.sweep = null; p.layer?.setSweep(null); }
    const b = $('#history-banner');
    b.hidden = !this.historyEnd;
    if (this.historyEnd) $('span', b).textContent = `Replaying ${U.dateTime(this.historyEnd, this.state.utc)}`;
    this.loadAll(true);
    if (!this.historyEnd) this.poll();
  }

  // ======================================================== modes

  applyMode() {
    document.body.classList.toggle('mode-simple', this.simple);
    document.body.classList.toggle('mode-pro', !this.simple);
  }

  setMode(mode) {
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    if (this.simple) {
      if (this.state.layout !== 1) this.setLayout(1);
      const cfg = this.state.panels[0];
      if (!SIMPLE_PRODUCTS.some(([id]) => id === cfg.p)) this.setProduct('REF', 0);
    }
    this.save();
    this.applyMode();
    this.renderProductStrip();
    this.renderLegend();
    this.renderFocus();
  }

  // ======================================================== location

  locate() {
    if (!navigator.geolocation) return this.toast('Location isn’t available in this browser.');
    this.toast('Finding your location…');
    const first = !this.userLoc;
    navigator.geolocation.getCurrentPosition((pos) => {
      this.setUserLoc(pos.coords);
      const { lng, lat } = this.userLoc;
      if (!this.site || first) {
        const near = this.nearestSites(lat, lng)[0];
        if (near && (!this.site || near.site.id !== this.site.id)) this.setSite(near.site.id, { keepView: true });
      }
      this.primaryMap.flyTo({ center: [lng, lat], zoom: Math.max(this.primaryMap.getZoom(), 8), duration: 900 });
      this.primaryMap.once('moveend', () => this.syncAll());
      if (!this.geoWatch) this.geoWatch = navigator.geolocation.watchPosition((p) => this.setUserLoc(p.coords), () => {}, { enableHighAccuracy: false, maximumAge: 60e3 });
    }, (err) => this.toast(err.code === 1 ? 'Location permission was denied.' : 'Couldn’t get your location.'), { enableHighAccuracy: false, timeout: 15e3, maximumAge: 120e3 });
  }

  setUserLoc(c) {
    this.userLoc = { lng: c.longitude, lat: c.latitude };
    this.placeUserMarkers();
    if (!this.focus || this.focus.me) this.focus = { name: 'Your location', lat: c.latitude, lon: c.longitude, me: true };
    this.renderFocus();
  }

  placeUserMarkers() {
    for (const p of this.panels) {
      if (!p.me) {
        const el = document.createElement('div');
        el.className = 'me';
        p.me = new maplibregl.Marker({ element: el });
      }
      p.me.setLngLat([this.userLoc.lng, this.userLoc.lat]).addTo(p.map);
    }
  }

  // ======================================================== chrome (static UI)

  buildChrome() {
    document.documentElement.dataset.basemap = this.state.basemap;
    const dock = $('.dock');
    new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`)).observe(dock);
    $('#btn-site').addEventListener('click', () => this.openSites());
    $('#btn-search').addEventListener('click', () => this.openSearch());
    $('#btn-product').addEventListener('click', () => this.openProducts());
    $('#btn-layers').addEventListener('click', () => this.openLayers());
    $('#btn-settings').addEventListener('click', () => this.openSettings());
    $('#btn-alerts').addEventListener('click', () => this.openAlerts());
    $('#btn-locate').addEventListener('click', () => this.locate());
    $('#btn-share').addEventListener('click', () => this.share());
    $('#btn-layout').addEventListener('click', (e) => { e.stopPropagation(); $('#layout-menu').hidden = !$('#layout-menu').hidden; });
    $$('#layout-menu [data-layout]').forEach((b) => {
      b.setAttribute('aria-checked', String(+b.dataset.layout === this.state.layout));
      b.addEventListener('click', () => { $('#layout-menu').hidden = true; this.setLayout(+b.dataset.layout); });
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#layout-menu, #btn-layout')) $('#layout-menu').hidden = true; });
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-prev').addEventListener('click', () => { this.togglePlay(false); this.step(-1); });
    $('#btn-next').addEventListener('click', () => { this.togglePlay(false); this.step(1); });
    $('#btn-live').addEventListener('click', () => this.goLive());
    $('#scrub').addEventListener('input', (e) => {
      this.togglePlay(false);
      this.frameIndex = +e.target.value;
      this.live = this.frameIndex === this.realCount - 1;
      this.showFrame();
    });
    $('#sheet-close').addEventListener('click', () => this.closeSheet());
    $('#scrim').addEventListener('click', () => this.closeSheet());
    document.addEventListener('click', (e) => this.onAction(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.renderProductStrip();
  }

  onAction(e) {
    const t = e.target.closest('[data-act], [data-i], [data-arr], [data-line]');
    if (!t) return;
    if (t.dataset.line != null) {
      const l = this.focusLines?.[+t.dataset.line];
      if (l?.warning) { const d = this.overlays.describe(l.warning); return this.openSheet(d.title, d.html, d.color); }
      if (l?.cell) { const d = this.overlays.describe({ properties: { ...l.cell, kind: 'storm', color: '#ffcc00' } }); return this.openSheet(d.title, d.html, d.color); }
      return;
    }
    if (t.dataset.arr != null) {
      const m = this.arrivalMsgs[+t.dataset.arr];
      if (m.f) { const d = this.overlays.describe(m.f); this.openSheet(d.title, d.html, d.color); }
      if (m.cell) { const d = this.overlays.describe({ properties: { ...m.cell, kind: 'storm', color: '#ffcc00' } }); this.openSheet(d.title, d.html, d.color); }
      return;
    }
    if (t.dataset.i != null && t.closest('#inspect')) {
      const d = this.inspectFeatures[+t.dataset.i];
      return this.openSheet(d.title, d.html, d.color);
    }
    switch (t.dataset.act) {
      case 'search': $('#welcome')?.remove(); return this.openSearch();
      case 'save-place': return this.toggleSave();
      case 'clear-focus': return this.clearFocus();
      case 'mode-pro': this.closeSheet(); return this.setMode('pro');
      case 'mode-simple': this.closeSheet(); return this.setMode('simple');
      case 'back-live': return this.setHistory(null);
      case 'close-inspect': return this.closeInspect();
      case 'clear-filter': delete this.state.filters[this.state.panels[this.state.active].p]; this.save(); this.applyPanelProducts(); return;
      case 'locate': this.closeSheet(); $('#welcome')?.remove(); return this.locate();
      case 'dismiss-welcome': return $('#welcome')?.remove();
      case 'about': return this.openAbout();
      case 'install': return this.install();
    }
  }

  onKey(e) {
    if (e.key === 'Escape') { this.closeSheet(); this.closeInspect(); return; }
    if (e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); this.togglePlay(); }
    else if (k === 'arrowleft') { this.togglePlay(false); this.step(-1); }
    else if (k === 'arrowright') { this.togglePlay(false); this.step(1); }
    else if (k === 'arrowup') { e.preventDefault(); this.setTilt(this.state.panels[this.state.active].t + 1); }
    else if (k === 'arrowdown') { e.preventDefault(); this.setTilt(this.state.panels[this.state.active].t - 1); }
    else if (k === 's') { this.state.smooth = !this.state.smooth; this.save(); this.panels.forEach((p) => this.applyLayerOptions(p)); this.toast(this.state.smooth ? 'Smoothing on' : 'Raw gates'); }
    else if (k === 'l') this.goLive();
    else if (/^[1-9]$/.test(k)) { const p = PRODUCTS[+k - 1]; if (p) this.setProduct(p.id); }
    else if (k === '0') { const p = PRODUCTS[9]; if (p) this.setProduct(p.id); }
  }

  renderProductStrip() {
    const cfg = this.state.panels[this.state.active];
    const strip = $('#product-strip');
    const list = this.simple ? SIMPLE_PRODUCTS.map(([id, label]) => ({ ...PRODUCT[id], short: label })) : PRODUCTS;
    strip.innerHTML = list.map((p) => `<button type="button" role="radio" aria-checked="${p.id === cfg.p}" data-p="${p.id}" title="${p.name}">${p.short}</button>`).join('');
    $$('button', strip).forEach((b) => b.addEventListener('click', () => this.setProduct(b.dataset.p)));
    this.renderTilts();
  }

  renderTilts() {
    const cfg = this.state.panels[this.state.active];
    const prod = PRODUCT[cfg.p];
    const el = $('#tilts');
    el.hidden = !!prod.volume;
    if (prod.volume) return;
    el.innerHTML = prod.codes.map((c, i) => `<button type="button" role="radio" aria-checked="${i === cfg.t}" data-t="${i}" title="Elevation slot ${i + 1} (${c})">${TILT_HINT[i]}</button>`).join('');
    $$('button', el).forEach((b) => b.addEventListener('click', () => this.setTilt(+b.dataset.t)));
  }

  renderTiltLabels() {
    const sw = this.activePanel?.sweep;
    const cfg = this.state.panels[this.state.active];
    if (!sw || PRODUCT[cfg.p].volume) return;
    const b = $(`#tilts [data-t="${cfg.t}"]`);
    if (b) b.textContent = `${sw.meta.elevation.toFixed(1)}°`;
    this.updatePanelTags();
  }

  // ======================================================== sheets

  openSheet(title, html, color, kind = '') {
    const sh = $('#sheet');
    $('#sheet-title').textContent = title;
    $('#sheet-title').style.setProperty('--c', color || 'transparent');
    $('#sheet-title').classList.toggle('dot', !!color);
    $('#sheet-body').innerHTML = html;
    sh.dataset.kind = kind;
    sh.hidden = false;
    $('#scrim').hidden = false;
    $('#sheet-body').scrollTop = 0;
    return $('#sheet-body');
  }

  closeSheet() {
    $('#sheet').hidden = true;
    $('#scrim').hidden = true;
    $('#sheet').dataset.kind = '';
  }

  openSites() {
    const c = this.primaryMap.getCenter();
    const list = this.nearestSites(c.lat, c.lng);
    const u = this.state.units.distance;
    const body = this.openSheet('Choose a radar', `
      <div class="sheet-tools"><input type="search" id="site-q" placeholder="Search ID, city or state" autocomplete="off">
      <button class="btn" data-act="locate">${ICON.locate}<span>Nearest to me</span></button></div>
      <div class="site-list" id="site-list"></div>
      <label class="row"><input type="checkbox" id="auto-site" ${this.state.autoSite ? 'checked' : ''}> Switch radars automatically as I pan</label>`, null, 'sites');
    const render = (q) => {
      const ql = q.trim().toLowerCase();
      const rows = list.filter(({ site }) => !ql || site.id.toLowerCase().includes(ql) || site.name.toLowerCase().includes(ql));
      $('#site-list', body).innerHTML = rows.slice(0, 80).map(({ site, km }) => `<button type="button" class="site-row ${this.site?.id === site.id ? 'cur' : ''}" data-site="${site.id}">
        <b>${site.id}</b><span>${esc(site.name)}</span><small>${U.fmtU(U.distance(km, u))}</small></button>`).join('') || '<p class="note">No radar matches.</p>';
    };
    render('');
    $('#site-q', body).addEventListener('input', (e) => render(e.target.value));
    $('#site-list', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-site]');
      if (b) { this.closeSheet(); this.setSite(b.dataset.site); }
    });
    $('#auto-site', body).addEventListener('change', (e) => { this.state.autoSite = e.target.checked; this.save(); });
    if (!matchMedia('(hover: none)').matches) $('#site-q', body).focus();
  }

  openProducts() {
    const cfg = this.state.panels[this.state.active];
    const panelNote = this.state.layout > 1 ? ` <span class="note">(panel ${this.state.active + 1})</span>` : '';
    const prod = PRODUCT[cfg.p];
    const presets = FILTER_PRESETS[prod.palette] || [];
    const f = this.state.filters[cfg.p];
    const body = this.openSheet('Product', `
      <div class="prod-grid">${PRODUCTS.map((p) => `<button type="button" class="prod ${p.id === cfg.p ? 'cur' : ''}" data-p="${p.id}">
        <b>${p.short}</b><span>${p.name}</span></button>`).join('')}</div>
      <p class="about-prod"><b>${prod.name}.</b> ${prod.about}${panelNote}</p>
      ${prod.volume ? '' : `<h4>Elevation</h4><div class="seg wide" id="sheet-tilts">${prod.codes.map((c, i) => `<button type="button" role="radio" aria-checked="${i === cfg.t}" data-t="${i}">${TILT_HINT[i]}</button>`).join('')}</div>
        <p class="note">Lowest scan first. Exact angles depend on the radar's scanning mode and show once loaded.</p>`}
      ${prod.srv ? this.srmControls() : ''}
      ${presets.length && !prod.categorical ? `<h4>Highlight a range</h4><div class="chips">${presets.map(([n, lo, hi], i) => `<button type="button" class="chip ${f && f[0] === lo && f[1] === hi ? 'on' : ''}" data-preset="${i}">${n}</button>`).join('')}
        ${f ? '<button type="button" class="chip" data-preset="-1">Show everything</button>' : ''}</div>
        <p class="note">Hides everything outside the range so cores, debris or flooding rain stand out.</p>` : ''}`, null, 'products');
    $$('.prod', body).forEach((b) => b.addEventListener('click', () => { this.setProduct(b.dataset.p); this.openProducts(); }));
    $$('#sheet-tilts button', body).forEach((b) => b.addEventListener('click', () => { this.setTilt(+b.dataset.t); this.openProducts(); }));
    $$('[data-preset]', body).forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.preset;
      if (i < 0) delete this.state.filters[cfg.p];
      else this.state.filters[cfg.p] = [presets[i][1], presets[i][2]];
      this.save();
      this.applyPanelProducts();
      this.openProducts();
    }));
    this.bindSrm(body);
  }

  srmControls() {
    const s = this.state.srm;
    const auto = this.overlays.meanMotion();
    return `<h4>Storm motion</h4>
      <div class="seg" id="srm-mode"><button type="button" role="radio" aria-checked="${s.mode === 'auto'}" data-m="auto">Auto</button><button type="button" role="radio" aria-checked="${s.mode === 'manual'}" data-m="manual">Manual</button></div>
      <p class="note">${auto ? `Auto uses the mean motion of ${auto.n} tracked cells at this radar.` : 'No cells are tracked right now, so auto falls back to the manual values.'}</p>
      <div class="row2"><label>From (°)<input type="number" id="srm-dir" min="0" max="359" value="${s.dir}"></label>
      <label>Speed (kt)<input type="number" id="srm-kt" min="0" max="120" value="${s.kt}"></label></div>`;
  }

  bindSrm(body) {
    const apply = () => { this.save(); this.panels.forEach((p) => this.applyLayerOptions(p)); this.renderLegend(); };
    $$('#srm-mode button', body).forEach((b) => b.addEventListener('click', () => {
      this.state.srm.mode = b.dataset.m;
      $$('#srm-mode button', body).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      apply();
    }));
    $('#srm-dir', body)?.addEventListener('change', (e) => { this.state.srm.dir = ((+e.target.value % 360) + 360) % 360; this.state.srm.mode = 'manual'; apply(); });
    $('#srm-kt', body)?.addEventListener('change', (e) => { this.state.srm.kt = Math.max(0, +e.target.value || 0); this.state.srm.mode = 'manual'; apply(); });
  }

  openLayers() {
    const o = this.state.overlays;
    const sw = (key, label, note = '') => `<label class="switch"><input type="checkbox" data-ov="${key}" ${o[key] ? 'checked' : ''}><span class="sw"></span><span class="lbl">${label}${note ? `<small>${note}</small>` : ''}</span></label>`;
    const pro = !this.simple;
    const mrms = `<div class="field"><span>${pro ? 'Rainfall (MRMS)' : 'Rain totals map'}</span><div class="seg" id="mrms">${[['off', 'Off'], ['p1h', '1 h'], ['p24h', '24 h'], ['p48h', '48 h'], ['p72h', '72 h']].map(([k, l]) => `<button type="button" role="radio" aria-checked="${o.mrms === k}" data-v="${k}">${l}</button>`).join('')}</div></div>`;
    const basemap = `<div class="field"><span>Map style</span><div class="seg" id="basemap">${[['dark', 'Dark'], ['light', 'Light'], ['satellite', 'Satellite']].map(([k, l]) => `<button type="button" role="radio" aria-checked="${this.state.basemap === k}" data-v="${k}">${l}</button>`).join('')}</div></div>`;
    const body = this.openSheet('Layers', pro ? `
      <h4>Severe weather</h4>
      ${sw('warnings', 'Warnings', 'Storm-based NWS warnings, updated every minute')}
      <div class="chips warn-types">${WARNING_TYPES.map((w) => `<button type="button" class="chip ${this.state.warningTypes[w.key] ? 'on' : ''}" data-wt="${w.key}" style="--c:${w.color}">${w.event.replace(' Warning', '').replace('Special Weather Statement', 'Special Wx Statement')}</button>`).join('')}</div>
      ${sw('lightning', 'Lightning', 'Strike density over the last 15 minutes (NLDN/GLD360 via NOAA)')}
      ${sw('watches', 'Watches & mesoscale discussions', 'Storm Prediction Center')}
      ${sw('storms', 'Storm tracks', 'Cell IDs, hail, rotation and 60-minute forecast paths')}
      ${sw('tropical', 'Hurricanes', 'NHC cones, tracks, coastal watches/warnings and 7-day outlook')}
      ${sw('reports', 'Storm reports', 'Tornado, hail, wind and flood reports')}
      ${sw('spc', 'SPC Day 1 outlook')}
      <h4>Water</h4>
      ${sw('rivers', 'River gauges', 'Flood status and forecasts; tap a gauge for its hydrograph')}
      ${mrms}
      <h4>Map</h4>
      <div class="field"><span>National mosaic</span><div class="seg" id="mosaic">${[['auto', 'Zoomed out'], ['on', 'Always'], ['off', 'Never']].map(([k, l]) => `<button type="button" role="radio" aria-checked="${o.mosaic === k}" data-v="${k}">${l}</button>`).join('')}</div></div>
      ${sw('satellite', 'Satellite (GOES infrared)')}
      ${sw('rings', 'Range rings')}
      ${sw('sites', 'Radar sites')}
      ${basemap}` : `
      ${sw('warnings', 'Warnings', 'Tornado, severe storm and flash flood warnings')}
      ${sw('lightning', 'Lightning', 'Where lightning struck in the last 15 minutes')}
      ${sw('storms', 'Storm paths', 'Where strong storms are heading over the next hour')}
      ${sw('tropical', 'Hurricanes', 'Forecast cones and tracks from the National Hurricane Center')}
      ${sw('rivers', 'River levels', 'Rivers near or above flood stage')}
      ${sw('satellite', 'Clouds', 'Satellite view of clouds')}
      ${mrms}
      ${basemap}
      <p class="note">Want velocity, dual-pol, multiple panels and more? <button type="button" class="linkish" data-act="mode-pro">Switch to Pro mode</button></p>`, null, 'layers');
    $$('[data-ov]', body).forEach((c) => c.addEventListener('change', () => {
      o[c.dataset.ov] = c.checked;
      this.save();
      if (c.checked) this.overlays.enable(c.dataset.ov);
      else this.overlays.applyAll();
      if (c.dataset.ov === 'rings') this.overlays.setRings();
      this.renderLegend();
    }));
    $$('[data-wt]', body).forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.wt;
      this.state.warningTypes[k] = !this.state.warningTypes[k];
      b.classList.toggle('on', this.state.warningTypes[k]);
      this.save();
      this.overlays.filterWarnings();
    }));
    segBind($('#mrms', body), (v) => { o.mrms = v; this.save(); this.overlays.reinstallRaster('ov-mrms'); this.overlays.applyAll(); this.renderLegend(); });
    segBind($('#mosaic', body), (v) => { o.mosaic = v; this.save(); this.overlays.applyAll(); this.updateSiteVisibility(); });
    segBind($('#basemap', body), (v) => this.setBasemap(v));
  }

  setBasemap(v) {
    this.state.basemap = v;
    this.save();
    for (const p of this.panels) {
      this.overlays.uninstall(p.map);
      p.map.setStyle(buildStyle(v), { diff: false });
    }
    document.documentElement.dataset.basemap = v;
  }

  openSettings() {
    const s = this.state;
    const unitSeg = (k) => `<div class="field"><span>${{ speed: 'Wind speed', distance: 'Distance', height: 'Height', rain: 'Rainfall' }[k]}</span><div class="seg" data-unit="${k}">${U.UNIT_OPTIONS[k].map(([v, l]) => `<button type="button" role="radio" aria-checked="${s.units[k] === v}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
    const pals = ['REF', 'VEL', 'CC', 'ZDR', 'KDP', 'HC', 'VIL', 'ET', 'PRECIP'];
    const histVal = this.historyEnd ? new Date((this.historyEnd - new Date().getTimezoneOffset() * 60) * 1000).toISOString().slice(0, 16) : '';
    const body = this.openSheet('Settings', `
      <div class="field"><span>Mode</span><div class="seg wide" id="set-mode"><button type="button" role="radio" aria-checked="${this.simple}" data-v="simple">Simple</button><button type="button" role="radio" aria-checked="${!this.simple}" data-v="pro">Pro</button></div>
        <small class="note">${this.simple ? 'Simple keeps things plain: radar, rain totals and what’s coming to your places.' : 'Pro shows every product, elevation, panel and tool.'}</small></div>
      <label class="switch"><input type="checkbox" id="set-notify" ${s.notify ? 'checked' : ''}><span class="sw"></span><span class="lbl">Alerts for my places<small>Notifies you about warnings and rain on the way for your location and saved places while Watergaw is open.</small></span></label>
      <label class="switch"><input type="checkbox" id="set-forecast" ${s.forecast ? 'checked' : ''}><span class="sw"></span><span class="lbl">Show the next hour<small>Projects current storms forward up to 60 minutes. A forecast, not a guarantee.</small></span></label>
      ${this.simple ? '' : `<div class="field"><span>Go back in time</span><div class="row2"><input type="datetime-local" id="set-history" value="${histVal}" min="2022-02-19T00:00"><button type="button" class="btn small" data-act="back-live">Back to live</button></div>
        <small class="note">Replay any storm since February 2022 at this radar.</small></div>`}
      <h4>Display</h4>
      <label class="switch"><input type="checkbox" id="set-smooth" ${s.smooth ? 'checked' : ''}><span class="sw"></span><span class="lbl">Smooth radar<small>Interpolates between gates. Off shows every raw gate (key: S).</small></span></label>
      <div class="field"><span>Radar opacity</span><input type="range" id="set-opacity" min="0.3" max="1" step="0.05" value="${s.opacity}"></div>
      <label class="switch"><input type="checkbox" id="set-utc" ${s.utc ? 'checked' : ''}><span class="sw"></span><span class="lbl">Show times in UTC</span></label>
      <h4>Loop</h4>
      <div class="field"><span>Frames</span><div class="seg" id="set-frames">${[6, 12, 20, 30, 60].map((n) => `<button type="button" role="radio" aria-checked="${s.frames === n}" data-v="${n}">${n}</button>`).join('')}</div></div>
      <div class="field"><span>Speed</span><div class="seg" id="set-speed">${[[0.5, 'Slow'], [1, 'Normal'], [2, 'Fast']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${s.speed === v}" data-v="${v}">${l}</button>`).join('')}</div></div>
      <h4>Units</h4>
      ${['speed', 'distance', 'height', 'rain'].map(unitSeg).join('')}
      <h4>Color tables</h4>
      <p class="note">Import any GR-format <code>.pal</code> color table (the format GRLevelX, Supercell Wx and RadarOmega use).</p>
      <div class="pal-list">${pals.map((k) => `<div class="pal-row"><span class="pal-name">${k}</span><span class="pal-bar" style="background:${this.palBar(k)}"></span>
        <label class="btn small">Import<input type="file" accept=".pal,.txt,text/plain" data-pal="${k}" hidden></label>
        ${s.palettes[k] ? `<button type="button" class="btn small" data-reset="${k}">Reset</button>` : ''}</div>`).join('')}</div>
      <h4>App</h4>
      <div class="chips"><button type="button" class="chip" data-act="about">About Watergaw & data</button>
      ${this.installPrompt ? '<button type="button" class="chip on" data-act="install">Install app</button>' : ''}</div>
      <p class="note">Keyboard: space play/pause · ←/→ frames · ↑/↓ elevation · 1–9 products · S smoothing · L live.</p>`, null, 'settings');
    segBind($('#set-mode', body), (v) => { this.setMode(v); this.openSettings(); });
    $('#set-notify', body).addEventListener('change', async (e) => { if (!(await this.enableAlerts(e.target.checked))) e.target.checked = false; });
    $('#set-forecast', body).addEventListener('change', (e) => { s.forecast = e.target.checked; this.save(); this.forecast = null; this.updateNowcast(); this.rebuildTimeline(); this.renderFocus(); });
    $('#set-history', body)?.addEventListener('change', (e) => { const t = Date.parse(e.target.value); if (t) this.setHistory(t / 1000); });
    $('#set-smooth', body).addEventListener('change', (e) => { s.smooth = e.target.checked; this.save(); this.panels.forEach((p) => this.applyLayerOptions(p)); });
    $('#set-opacity', body).addEventListener('input', (e) => { s.opacity = +e.target.value; this.save(); this.panels.forEach((p) => this.applyLayerOptions(p)); });
    $('#set-utc', body).addEventListener('change', (e) => { s.utc = e.target.checked; this.save(); this.updatePanelTags(); this.renderTimeLabel(); });
    segBind($('#set-frames', body), (v) => { s.frames = +v; this.save(); for (const x of this.series.values()) x.keys = []; this.loadAll(true); });
    segBind($('#set-speed', body), (v) => { s.speed = +v; this.save(); });
    $$('[data-unit]', body).forEach((el) => segBind(el, (v) => {
      s.units[el.dataset.unit] = v;
      this.save();
      this.renderLegend();
      this.overlays.setRings();
      this.checkArrivals();
    }));
    $$('[data-pal]', body).forEach((inp) => inp.addEventListener('change', async () => {
      const file = inp.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        parsePal(text);
        s.palettes[inp.dataset.pal] = text;
        this.save();
        this.applyPanelProducts();
        this.toast(`Loaded ${file.name}`);
        this.openSettings();
      } catch (err) { this.toast(`That color table didn’t load: ${err.message}`); }
    }));
    $$('[data-reset]', body).forEach((b) => b.addEventListener('click', () => { delete s.palettes[b.dataset.reset]; this.save(); this.applyPanelProducts(); this.openSettings(); }));
  }

  palBar(name) {
    const pal = this.palette(name);
    const e = pal.entries;
    const lo = (e[0].v - pal.offset) / pal.scale;
    const hi = (e[e.length - 1].v - pal.offset) / pal.scale;
    return cssGradient(pal, lo, hi, 32);
  }

  openAlerts() {
    const list = [...(this.warnings || [])];
    const site = this.site;
    const dist = (f) => {
      const c = bboxCenter(f.geometry);
      return site && c ? this.core.polar(site.lat, site.lon, 0, c[1], c[0]).ground : 0;
    };
    const order = Object.fromEntries(WARNING_TYPES.map((w, i) => [w.key, i]));
    list.sort((a, b) => (b.properties.emph - a.properties.emph) || (order[a.properties.key] - order[b.properties.key]) || dist(a) - dist(b));
    const near = site ? list.filter((f) => dist(f) < 500) : list;
    const rest = site ? list.filter((f) => dist(f) >= 500) : [];
    const row = (f, i) => {
      const p = f.properties;
      return `<button type="button" class="alert-row" data-w="${i}" style="--c:${p.color}">
        <b>${p.emph === 2 && p.key === 'TOR' ? 'TORNADO EMERGENCY' : esc(p.event)}${p.emph === 1 ? ' · ' + esc(p.threat || p.detection) : ''}</b>
        <span>${esc(p.area.split(';').slice(0, 3).join(';'))}${p.area.split(';').length > 3 ? '…' : ''}</span>
        <small>until ${U.clock(Date.parse(p.expires) / 1000, this.state.utc)}</small></button>`;
    };
    const all = near.concat(rest);
    const body = this.openSheet('Active warnings', `
      ${!list.length ? '<p class="note">No active warnings of the types you have switched on.</p>' : ''}
      ${near.length ? `<h4>${site ? `Near ${site.id}` : 'All'}</h4>${near.map((f) => row(f, all.indexOf(f))).join('')}` : ''}
      ${rest.length ? `<h4>Elsewhere</h4>${rest.slice(0, 60).map((f) => row(f, all.indexOf(f))).join('')}` : ''}
      <p class="note">From the National Weather Service. Turn types on or off under Layers.</p>`, null, 'alerts');
    $$('[data-w]', body).forEach((b) => b.addEventListener('click', () => {
      const f = all[+b.dataset.w];
      const bb = bbox(f.geometry);
      if (bb) this.primaryMap.fitBounds(bb, { padding: 60, maxZoom: 10, duration: 800 });
      this.primaryMap.once('moveend', () => this.syncAll());
      const d = this.overlays.describe(f);
      this.openSheet(d.title, d.html, d.color);
    }));
  }

  async openGauge(p) {
    const body = this.openSheet(p.name, '<p class="note">Loading river data…</p>', GAUGE_COLORS[p.cat] || '#8e8e93', 'gauge');
    try {
      const html = await this.overlays.gaugeHtml(p);
      if ($('#sheet').dataset.kind === 'gauge') body.innerHTML = html;
    } catch (e) {
      body.innerHTML = `<p class="note">Couldn’t load this gauge: ${esc(e.message)}</p>`;
    }
  }

  openAbout() {
    this.openSheet('About Watergaw', `
      <p><b>Pro-grade radar, free for everyone.</b> Watergaw draws NEXRAD data the way professional viewers do: straight from each radar's own polar scans, decoded on your device, with no paywall, account, ads or tracking.</p>
      <ul class="feat">
        <li>Super-resolution reflectivity and velocity, six elevation angles</li>
        <li>Storm-relative velocity computed at full resolution with live or manual storm motion</li>
        <li>Dual-pol: correlation coefficient, ZDR, KDP and hydrometeor classification</li>
        <li>VIL, echo tops, and 1-hour, 3-hour, 24-hour and storm-total rainfall</li>
        <li>Up to four synchronized panels with a linked cursor</li>
        <li>Storm tracks with hail, rotation and arrival times for your location</li>
        <li>Warnings with damage-threat tags, watches, SPC outlooks and storm reports</li>
        <li>River gauges with flood status and forecast hydrographs, plus MRMS rainfall</li>
        <li>Smooth or raw gates, range highlighting and GR-compatible color tables</li>
      </ul>
      <h4>Data</h4>
      <p class="note">NEXRAD Level III from the NOAA Open Data Dissemination program (AWS, Unidata). Warnings: National Weather Service API. Watches, mesoscale discussions, storm attributes, storm reports, the national mosaic and MRMS rainfall tiles: Iowa Environmental Mesonet. Outlooks: Storm Prediction Center. River gauges and forecasts: National Water Prediction Service. Satellite: NASA GIBS. Basemap: OpenFreeMap / OpenStreetMap. Counties: US Census Bureau.</p>
      <h4>Please note</h4>
      <p class="note">Watergaw is an independent project, not affiliated with NOAA or the National Weather Service. Data can be delayed or missing. Don't rely on it alone for life-safety decisions: follow official NWS warnings and local emergency officials.</p>
      <h4>Why “Watergaw”?</h4>
      <p class="note">A watergaw is an old Scots word for a faint, broken piece of rainbow seen in the rain, long taken as a sign that weather is on the way. Radar paints rain in rainbow colors too.</p>
      <h4>The logo</h4>
      <p class="note">It's real radar data: Hurricane Harvey coming ashore near Rockport, Texas, as seen by the Corpus Christi radar (KCRP) at 03:04 UTC on 26 August 2017, contoured in Watergaw's reflectivity colors.</p>
      <p class="note">Version ${VERSION} · <a href="https://github.com/TheOnlyRealAgentP/watergaw" target="_blank" rel="noopener">Source code (MIT)</a></p>`, null, 'about');
  }

  showWelcome() {
    const el = document.createElement('div');
    el.id = 'welcome';
    el.className = 'welcome';
    el.innerHTML = `<img class="welcome-logo" src="icons/icon.svg" alt="" width="84" height="84"><h2>Watergaw</h2><p>Pro-grade radar, free for everyone.</p>
      <div class="welcome-actions"><button class="btn primary" data-act="locate">${ICON.locate}<span>Use my location</span></button>
      <button class="btn" data-act="search">${ICON.search}<span>Search a place</span></button></div>
      <p class="note">Or tap any radar site on the map${this.simple ? '. Weather pro? <button type="button" class="linkish" id="welcome-pro">Use Pro mode</button>' : ''}.</p>
      <button class="icon-btn close" data-act="dismiss-welcome" aria-label="Close">${ICON.x}</button>`;
    document.body.appendChild(el);
    $('#welcome-pro')?.addEventListener('click', () => { this.setMode('pro'); el.querySelector('.note').textContent = 'Pro mode on. Tap any radar site on the map.'; });
  }

  // ======================================================== misc

  async share() {
    this.save();
    await new Promise((r) => setTimeout(r, 350));
    const url = location.href;
    try {
      if (navigator.share && matchMedia('(hover: none)').matches) await navigator.share({ title: 'Watergaw radar', url });
      else { await navigator.clipboard.writeText(url); this.toast('Link copied'); }
    } catch { /* cancelled */ }
  }

  toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  onOverlayStatus(name) {
    const st = this.overlays.status[name];
    if (st && !st.ok && !this.reported?.[name]) {
      this.reported = { ...this.reported, [name]: true };
      console.warn(`Overlay ${name} failed:`, st.error);
    }
  }

  registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.installPrompt = e; });
  }

  async install() {
    if (!this.installPrompt) return;
    this.installPrompt.prompt();
    await this.installPrompt.userChoice;
    this.installPrompt = null;
  }
}

// ======================================================== helpers

function ageClass(t) {
  const m = (Date.now() / 1000 - t) / 60;
  return m < 8 ? 'fresh' : m < 20 ? 'stale' : 'old';
}

function stepLegend(title, items) {
  return `<div class="lg"><div class="lg-title">${title}</div><div class="lg-steps">${items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div></div>`;
}

function segBind(el, fn) {
  if (!el) return;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    $$('button', el).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    fn(b.dataset.v);
  });
}

function rings(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function pointInGeom(pt, g) {
  for (const poly of rings(g)) {
    let inside = false;
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
      }
      if (r === 0) inside = c;
      else if (c) inside = false;
    }
    if (inside) return true;
  }
  return false;
}

function bbox(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of rings(g)) for (const ring of poly) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return Number.isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
}

function bboxCenter(g) {
  const b = bbox(g);
  return b && [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
}

const ICON = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" aria-hidden="true" class="on"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z" fill="#ffd60a" stroke="#ffd60a"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
};

const app = new App();
window.watergaw = app;
app.start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div class="fatal"><h2>Watergaw couldn’t start</h2><p>${esc(e.message)}</p><p>It needs a current browser with WebGL 2 and WebAssembly.</p></div>`);
});
