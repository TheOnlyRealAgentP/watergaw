// Everything drawn on top of (or under) the radar besides the radar itself:
// warnings, watches, SPC products, storm cells, storm reports, river gauges,
// rainfall and satellite rasters, the national mosaic, range rings and radar
// sites. Data is fetched once and pushed into every panel's map.

import { ANCHOR_OVERLAY, ANCHOR_RADAR } from './style.js';
import { compass, fmt, fmtU, knotsTo, distance, rain, height, dateTime } from './units.js';

const NWS = 'https://api.weather.gov';
const IEM = 'https://mesonet.agron.iastate.edu';
const NWPS = 'https://api.water.noaa.gov/nwps/v1';

export const WARNING_TYPES = [
  { event: 'Tornado Warning', key: 'TOR', color: '#ff2d55', on: true },
  { event: 'Extreme Wind Warning', key: 'EWW', color: '#ff6bf2', on: true },
  { event: 'Severe Thunderstorm Warning', key: 'SVR', color: '#ffb020', on: true },
  { event: 'Flash Flood Warning', key: 'FFW', color: '#2ee66b', on: true },
  { event: 'Snow Squall Warning', key: 'SQW', color: '#7fd3ff', on: true },
  { event: 'Dust Storm Warning', key: 'DSW', color: '#d9b38c', on: true },
  { event: 'Special Marine Warning', key: 'SMW', color: '#ff8c3a', on: true },
  { event: 'Flood Warning', key: 'FLW', color: '#13b38a', on: false },
  { event: 'Flood Advisory', key: 'FLA', color: '#5fd3b0', on: false },
  { event: 'Special Weather Statement', key: 'SPS', color: '#f5deb3', on: false },
];
const WARN_BY_EVENT = Object.fromEntries(WARNING_TYPES.map((w) => [w.event, w]));

export const GAUGE_COLORS = {
  major: '#c74dff', moderate: '#ff3b30', minor: '#ff9500', action: '#ffd60a',
  no_flooding: '#34c759', low_water: '#8e8e93',
};
const GAUGE_LABEL = { major: 'Major flooding', moderate: 'Moderate flooding', minor: 'Minor flooding', action: 'Near flood stage', no_flooding: 'Below flood stage', low_water: 'Low water', not_defined: 'No flood stages defined', obs_not_current: 'Observations not current', out_of_service: 'Out of service' };

export const LSR_TYPES = {
  T: ['Tornado', '#ff2d55', 'T'], C: ['Funnel cloud', '#ff8fa3', 'C'], W: ['Waterspout', '#ff8fa3', 'W'],
  H: ['Hail', '#34c759', 'H'], A: ['Marine hail', '#34c759', 'H'],
  G: ['Wind gust', '#5ac8fa', 'G'], D: ['Wind damage', '#0a84ff', 'D'], M: ['Marine wind', '#5ac8fa', 'G'], N: ['Wind', '#5ac8fa', 'G'], O: ['Wind', '#5ac8fa', 'G'],
  F: ['Flash flood', '#00c7be', 'F'], E: ['Flood', '#00c7be', 'F'], R: ['Heavy rain', '#64d2ff', 'R'],
  S: ['Snow', '#e5e5ea', 'S'], Z: ['Freezing rain', '#bf5af2', 'Z'], s: ['Sleet', '#bf5af2', 'S'], B: ['Blizzard', '#e5e5ea', 'B'],
  X: ['Funnel cloud', '#ff8fa3', 'C'], L: ['Lightning', '#ffd60a', 'L'], U: ['Fire', '#ff9f0a', 'U'],
};

export const MRMS_LAYERS = {
  p1h: ['q2-n1p-900913', '1 hour'], p24h: ['q2-p24h-900913', '24 hours'], p48h: ['q2-p48h-900913', '48 hours'], p72h: ['q2-p72h-900913', '72 hours'],
};
// Colors of IEM's MRMS and composite tiles (from their published lookup tables).
export const MRMS_LEGEND = [[0.1, '#003cff'], [0.25, '#0096ff'], [0.5, '#00fe9c'], [0.75, '#00fe06'], [1, '#8afe00'], [1.5, '#c6fe00'], [2, '#fed200'], [3, '#fe5a00'], [4, '#fe0006'], [6, '#fe0096'], [8, '#fe00fe'], [10, '#fe28fe']];
export const MOSAIC_LEGEND = [[5, '#6376a8'], [10, '#4568a6'], [15, '#60b4d4'], [20, '#43d67e'], [25, '#0eb314'], [30, '#0b840e'], [35, '#327308'], [40, '#ffe200'], [45, '#ffac00'], [50, '#f80000'], [55, '#aa0000'], [60, '#ffeaff'], [65, '#f960fa'], [70, '#a400f7']];

const EMPTY = { type: 'FeatureCollection', features: [] };
const NOWCOAST = 'https://nowcoast.noaa.gov/geoserver/ows';
const NHC = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
export const LIGHTNING_LEGEND = `${NOWCOAST}?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer=lightning_detection:ldn_lightning_strike_density`;

// Saffir-Simpson category from max sustained wind (kt).
export function tropicalCategory(kt, type = '') {
  const t = String(type).toUpperCase();
  if (t.includes('PTC') || t.includes('POST') || t.includes('LOW') && !t.includes('TROP')) return { short: 'L', name: 'Low', color: '#9aa6b6' };
  if (!(kt >= 34)) return { short: 'D', name: 'Tropical depression', color: '#5ac8fa' };
  if (kt < 64) return { short: 'S', name: 'Tropical storm', color: '#34c759' };
  if (kt < 83) return { short: '1', name: 'Category 1 hurricane', color: '#ffd60a' };
  if (kt < 96) return { short: '2', name: 'Category 2 hurricane', color: '#ff9f0a' };
  if (kt < 113) return { short: '3', name: 'Category 3 major hurricane', color: '#ff453a' };
  if (kt < 137) return { short: '4', name: 'Category 4 major hurricane', color: '#ff2d92' };
  return { short: '5', name: 'Category 5 major hurricane', color: '#bf5af2' };
}
const TC_WW = { HWR: ['Hurricane Warning', '#ff2d55'], HWA: ['Hurricane Watch', '#ff9ed2'], TWR: ['Tropical Storm Warning', '#3d7bff'], TWA: ['Tropical Storm Watch', '#ffd60a'] };
const pick = (p, ...keys) => { for (const k of keys) for (const pk of Object.keys(p)) if (pk.toLowerCase() === k.toLowerCase() && p[pk] != null && p[pk] !== '') return p[pk]; return null; };

/** Mesocyclone detection strength rank (0 = none). Ranks 5+ are mesocyclones; 1-4 are weak circulations. */
export const mesoRank = (p) => (p.meso && p.meso !== 'NONE' ? parseInt(p.meso, 10) || 0 : 0);
export const hasTvs = (p) => !!(p.tvs && p.tvs !== 'NONE');

async function getJSON(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).hostname}`);
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function circle(lon, lat, km, core, n = 120) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(core.destination(lat, lon, (i / n) * 360, km));
  return pts;
}

export class Overlays {
  constructor(app) {
    this.app = app;
    this.maps = new Set();
    this.data = {};
    this.timers = {};
    this.status = {};
    this.gaugeCache = new Map();
    this.satTime = null;
    this.mosaicTime = null;
  }

  get s() { return this.app.state; }

  // ---------------------------------------------------------------- install

  install(map) {
    this.maps.add(map);
    const add = (id, layer, before) => { if (!map.getLayer(id)) map.addLayer({ id, ...layer }, before && map.getLayer(before) ? before : undefined); };
    const src = (id, def) => { if (!map.getSource(id)) map.addSource(id, def); };
    for (const name of ['spc', 'watch', 'mcd', 'warn', 'rings', 'storms', 'tracks', 'lsr', 'gauges', 'sites', 'trop-outlook', 'trop-cone', 'trop-ww', 'trop-line', 'trop-pts']) {
      src(`ov-${name}`, { type: 'geojson', data: this.data[name] || EMPTY });
    }
    // Rasters sit under the radar.
    this.installRasters(map);

    add('ov-spc-fill', { type: 'fill', source: 'ov-spc', paint: { 'fill-color': ['coalesce', ['get', 'fill'], '#888'], 'fill-opacity': 0.16 } }, ANCHOR_OVERLAY);
    add('ov-spc-line', { type: 'line', source: 'ov-spc', paint: { 'line-color': ['coalesce', ['get', 'stroke'], '#888'], 'line-width': 1.6 } }, ANCHOR_OVERLAY);
    add('ov-gauges', { type: 'circle', source: 'ov-gauges', minzoom: 5,
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3, 10, 6.5],
        'circle-stroke-color': 'rgba(0,0,0,0.75)', 'circle-stroke-width': 1.2 } }, ANCHOR_OVERLAY);
    add('ov-rings', { type: 'line', source: 'ov-rings', filter: ['==', ['get', 'kind'], 'ring'], paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 1, 'line-dasharray': [3, 3] } }, ANCHOR_OVERLAY);
    add('ov-spokes', { type: 'line', source: 'ov-rings', filter: ['==', ['get', 'kind'], 'spoke'], paint: { 'line-color': 'rgba(255,255,255,0.2)', 'line-width': 1 } }, ANCHOR_OVERLAY);
    add('ov-watch', { type: 'line', source: 'ov-watch', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [4, 2] } }, ANCHOR_OVERLAY);
    add('ov-mcd', { type: 'line', source: 'ov-mcd', paint: { 'line-color': '#4aa3ff', 'line-width': 2, 'line-dasharray': [2, 2] } }, ANCHOR_OVERLAY);
    add('ov-trop-outlook', { type: 'fill', source: 'ov-trop-outlook', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 } }, ANCHOR_OVERLAY);
    add('ov-trop-outlook-line', { type: 'line', source: 'ov-trop-outlook', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] } }, ANCHOR_OVERLAY);
    add('ov-trop-cone', { type: 'fill', source: 'ov-trop-cone', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.13 } }, ANCHOR_OVERLAY);
    add('ov-trop-cone-line', { type: 'line', source: 'ov-trop-cone', paint: { 'line-color': '#ffffff', 'line-width': 1.8, 'line-opacity': 0.9 } }, ANCHOR_OVERLAY);
    add('ov-trop-ww', { type: 'line', source: 'ov-trop-ww', paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': 0.95 } }, ANCHOR_OVERLAY);
    add('ov-warn-fill', { type: 'fill', source: 'ov-warn', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['>', ['get', 'emph'], 0], 0.22, 0.1] } }, ANCHOR_OVERLAY);
    add('ov-warn-casing', { type: 'line', source: 'ov-warn', paint: { 'line-color': 'rgba(0,0,0,0.85)', 'line-width': ['+', 4, ['*', 2, ['get', 'emph']]] } }, ANCHOR_OVERLAY);
    add('ov-warn-line', { type: 'line', source: 'ov-warn', paint: { 'line-color': ['get', 'color'], 'line-width': ['+', 2.2, ['*', 1.6, ['get', 'emph']]] } }, ANCHOR_OVERLAY);
    add('ov-tracks', { type: 'line', source: 'ov-tracks', filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.9 } });
    add('ov-track-ticks', { type: 'circle', source: 'ov-tracks', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 3, 'circle-color': '#0b0e13', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5 } });
    add('ov-track-labels', { type: 'symbol', source: 'ov-tracks', filter: ['==', ['geometry-type'], 'Point'], minzoom: 7.5,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 1.1], 'text-allow-overlap': false },
      paint: { 'text-color': '#e5e9f0', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.2 } });
    add('ov-storms', { type: 'circle', source: 'ov-storms',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 7], 'circle-color': ['get', 'color'],
        'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });
    add('ov-storm-labels', { type: 'symbol', source: 'ov-storms', minzoom: 6.5,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-allow-overlap': false },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.95)', 'text-halo-width': 1.5 } });
    add('ov-lsr', { type: 'circle', source: 'ov-lsr',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 9], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1.2 } });
    add('ov-lsr-text', { type: 'symbol', source: 'ov-lsr', minzoom: 6,
      layout: { 'text-field': ['get', 'glyph'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 8, 10, 11], 'text-allow-overlap': true },
      paint: { 'text-color': '#000' } });
    add('ov-ring-labels', { type: 'symbol', source: 'ov-rings', filter: ['==', ['get', 'kind'], 'label'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-allow-overlap': true },
      paint: { 'text-color': 'rgba(255,255,255,0.75)', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.2 } });
    add('ov-trop-line-past', { type: 'line', source: 'ov-trop-line', filter: ['==', ['get', 'past'], true],
      paint: { 'line-color': 'rgba(220,225,235,0.75)', 'line-width': 2.2 } });
    add('ov-trop-line', { type: 'line', source: 'ov-trop-line', filter: ['!=', ['get', 'past'], true],
      paint: { 'line-color': '#ffffff', 'line-width': 2.2, 'line-dasharray': [2, 2] } });
    add('ov-trop-pts', { type: 'circle', source: 'ov-trop-pts',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 7, 8, 11], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 2 } });
    add('ov-trop-pts-label', { type: 'symbol', source: 'ov-trop-pts',
      layout: { 'text-field': ['get', 'short'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 9, 8, 12], 'text-allow-overlap': true },
      paint: { 'text-color': '#0b0e13' } });
    add('ov-trop-pts-time', { type: 'symbol', source: 'ov-trop-pts', minzoom: 4,
      layout: { 'text-field': ['get', 'when'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-offset': [0, 1.5], 'text-anchor': 'top' },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.3 } });
    add('ov-sites', { type: 'circle', source: 'ov-sites',
      paint: { 'circle-radius': ['case', ['get', 'current'], 6, 4.5], 'circle-color': ['case', ['get', 'current'], '#3d8bff', 'rgba(20,24,30,0.9)'],
        'circle-stroke-color': ['case', ['get', 'current'], '#ffffff', 'rgba(160,180,210,0.9)'], 'circle-stroke-width': 1.5 } });
    add('ov-sites-label', { type: 'symbol', source: 'ov-sites', minzoom: 4.2,
      layout: { 'text-field': ['get', 'id'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-offset': [0, 1.15], 'text-anchor': 'top', 'text-allow-overlap': false },
      paint: { 'text-color': ['case', ['get', 'current'], '#ffffff', '#b7c3d4'], 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.3 } });
    this.applyVisibility(map);
  }

  installRasters(map) {
    // Rasters always sit directly under the radar layer.
    // (getStyle() omits custom layers, so look the radar up in the layer order.)
    const radar = map.getLayersOrder().find((id) => id.startsWith('radar-'));
    const before = radar || (map.getLayer(ANCHOR_RADAR) ? ANCHOR_RADAR : undefined);
    const sat = this.satUrl();
    if (sat && !map.getSource('ov-sat')) {
      map.addSource('ov-sat', { type: 'raster', tiles: [sat], tileSize: 256, maxzoom: 6, attribution: 'GOES imagery: NASA GIBS / NOAA' });
      map.addLayer({ id: 'ov-sat', type: 'raster', source: 'ov-sat', paint: { 'raster-opacity': 0.65, 'raster-fade-duration': 0 } }, before);
    }
    if (!map.getSource('ov-mosaic')) {
      map.addSource('ov-mosaic', { type: 'raster', tiles: [this.mosaicUrl()], tileSize: 256, maxzoom: 8, attribution: 'Mosaic: Iowa Environmental Mesonet' });
      map.addLayer({ id: 'ov-mosaic', type: 'raster', source: 'ov-mosaic', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, before);
    }
    if (!map.getSource('ov-lightning')) {
      // Above the radar so strikes show on top of storms.
      map.addSource('ov-lightning', { type: 'raster', tiles: [this.lightningUrl()], tileSize: 256, maxzoom: 10, attribution: 'Lightning: NOAA nowCOAST (NLDN/GLD360)' });
      map.addLayer({ id: 'ov-lightning', type: 'raster', source: 'ov-lightning', paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 0 } }, map.getLayer(ANCHOR_RADAR) ? ANCHOR_RADAR : undefined);
    }
    const mr = MRMS_LAYERS[this.s.overlays.mrms];
    if (mr && !map.getSource('ov-mrms')) {
      map.addSource('ov-mrms', { type: 'raster', tiles: [`${IEM}/cache/tile.py/1.0.0/${mr[0]}/{z}/{x}/{y}.png?v=${this.mrmsStamp || 0}`], tileSize: 256, maxzoom: 8, attribution: 'MRMS: NOAA NSSL via IEM' });
      map.addLayer({ id: 'ov-mrms', type: 'raster', source: 'ov-mrms', paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 } }, before);
    }
  }

  reinstallRaster(id) {
    for (const map of this.maps) {
      if (!map.isStyleLoaded?.() && !map.getStyle()) continue;
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
      this.installRasters(map);
      this.applyVisibility(map);
    }
  }

  uninstall(map) {
    this.maps.delete(map);
  }

  setData(name, fc) {
    this.data[name] = fc;
    for (const map of this.maps) map.getSource(`ov-${name}`)?.setData(fc);
  }

  vis(map, ids, on) {
    for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  applyVisibility(map) {
    const o = this.s.overlays;
    const z = map.getZoom();
    this.vis(map, ['ov-warn-fill', 'ov-warn-casing', 'ov-warn-line'], o.warnings);
    this.vis(map, ['ov-watch'], o.watches);
    this.vis(map, ['ov-mcd'], o.watches);
    this.vis(map, ['ov-spc-fill', 'ov-spc-line'], o.spc);
    this.vis(map, ['ov-storms', 'ov-storm-labels', 'ov-tracks', 'ov-track-ticks', 'ov-track-labels'], o.storms);
    this.vis(map, ['ov-lsr', 'ov-lsr-text'], o.reports);
    this.vis(map, ['ov-gauges'], o.rivers);
    this.vis(map, ['ov-rings', 'ov-spokes', 'ov-ring-labels'], o.rings);
    this.vis(map, ['ov-sites', 'ov-sites-label'], o.sites);
    this.vis(map, ['ov-sat'], o.satellite);
    this.vis(map, ['ov-lightning'], o.lightning);
    this.vis(map, ['ov-trop-outlook', 'ov-trop-outlook-line', 'ov-trop-cone', 'ov-trop-cone-line', 'ov-trop-ww', 'ov-trop-line', 'ov-trop-line-past', 'ov-trop-pts', 'ov-trop-pts-label', 'ov-trop-pts-time'], o.tropical);
    this.vis(map, ['ov-mrms'], !!MRMS_LAYERS[o.mrms]);
    const mosaicOn = o.mosaic === 'on' || (o.mosaic === 'auto' && z < this.app.siteZoomThreshold);
    this.vis(map, ['ov-mosaic'], mosaicOn);
  }

  applyAll() {
    for (const map of this.maps) this.applyVisibility(map);
  }

  // ---------------------------------------------------------------- refresh loops

  start() {
    const every = (name, ms, fn) => {
      const run = async () => {
        try { await fn(); this.status[name] = { ok: true, at: Date.now() }; } catch (e) { this.status[name] = { ok: false, error: e.message, at: Date.now() }; }
        this.app.onOverlayStatus?.(name);
      };
      run();
      clearInterval(this.timers[name]);
      this.timers[name] = setInterval(() => { if (!document.hidden) run(); }, ms);
    };
    every('warnings', 60e3, () => this.loadWarnings());
    every('storms', 120e3, () => this.loadStorms());
    every('watches', 180e3, () => this.loadWatches());
    every('spc', 900e3, () => (this.s.overlays.spc ? this.loadSpc() : null));
    every('reports', 300e3, () => (this.s.overlays.reports ? this.loadReports() : null));
    every('mosaic', 150e3, () => this.loadMosaicTime());
    every('sat', 600e3, () => (this.s.overlays.satellite ? this.loadSatTime() : null));
    every('mrms', 600e3, () => this.bumpMrms());
    every('lightning', 300e3, () => this.bumpLightning());
    every('tropical', 900e3, () => (this.s.overlays.tropical ? this.loadTropical() : null));
    this.setSites();
    this.setRings();
  }

  /** Called when the user toggles an overlay so data appears without waiting. */
  async enable(name) {
    try {
      if (name === 'spc') await this.loadSpc();
      if (name === 'reports') await this.loadReports();
      if (name === 'rivers') await this.loadGauges(true);
      if (name === 'satellite') await this.loadSatTime();
      if (name === 'mrms') this.reinstallRaster('ov-mrms');
      if (name === 'lightning') this.bumpLightning(true);
      if (name === 'tropical') {
        const n = await this.loadTropical();
        if (!n) this.app.toast('No tropical storms or hurricanes are active right now.');
      }
    } catch (e) {
      this.app.toast(`Couldn’t load ${name}: ${e.message}`);
    }
    this.applyAll();
  }

  // ---------------------------------------------------------------- warnings

  async loadWarnings() {
    const events = WARNING_TYPES.map((w) => w.event).join(',');
    const d = await getJSON(`${NWS}/alerts/active?status=actual&event=${encodeURIComponent(events)}`);
    const feats = [];
    for (const f of d.features || []) {
      if (!f.geometry) continue;
      const p = f.properties;
      const type = WARN_BY_EVENT[p.event];
      if (!type) continue;
      const prm = p.parameters || {};
      const first = (k) => (prm[k] && prm[k][0]) || '';
      const threat = (first('tornadoDamageThreat') || first('thunderstormDamageThreat') || first('flashFloodDamageThreat')).toUpperCase();
      const detection = (first('tornadoDetection') || first('flashFloodDetection')).toUpperCase();
      let emph = 0;
      if (threat === 'CONSIDERABLE' || detection === 'OBSERVED' || threat === 'DESTRUCTIVE') emph = 1;
      if (threat === 'CATASTROPHIC') emph = 2;
      feats.push({
        type: 'Feature', geometry: f.geometry, id: feats.length,
        properties: {
          kind: 'warning', nwsId: p.id, event: p.event, key: type.key, color: type.color, emph,
          threat, detection, hail: first('maxHailSize'), wind: first('maxWindGust'),
          headline: p.headline || '', area: p.areaDesc || '', sender: p.senderName || '',
          onset: p.onset || p.effective, expires: p.ends || p.expires,
          description: p.description || '', instruction: p.instruction || '',
        },
      });
    }
    // Most dangerous drawn last (on top).
    const order = Object.fromEntries(WARNING_TYPES.map((w, i) => [w.key, WARNING_TYPES.length - i]));
    feats.sort((a, b) => order[a.properties.key] - order[b.properties.key] || a.properties.emph - b.properties.emph);
    this.allWarnings = feats;
    this.filterWarnings();
  }

  filterWarnings() {
    const on = this.s.warningTypes;
    const feats = (this.allWarnings || []).filter((f) => on[f.properties.key]);
    this.setData('warn', { type: 'FeatureCollection', features: feats });
    this.app.onWarnings?.(feats);
  }

  // ---------------------------------------------------------------- watches, MDs, outlooks

  async loadWatches() {
    const [w, m] = await Promise.allSettled([getJSON(`${IEM}/json/spcwatch.py`), getJSON(`${IEM}/api/1/nws/spc_mcd.geojson`)]);
    if (w.status === 'fulfilled') {
      const feats = (w.value.features || []).map((f) => {
        const p = f.properties || {};
        const t = String(p.type || p.sel || p.phenomena || '').toUpperCase();
        const tor = t.includes('TOR');
        return { ...f, properties: { ...p, kind: 'watch', tor, color: tor ? '#ff375f' : '#ffd60a', label: `${tor ? 'Tornado' : 'Severe Thunderstorm'} Watch ${p.number ?? p.num ?? ''}`.trim() } };
      });
      this.setData('watch', { type: 'FeatureCollection', features: feats });
    }
    if (m.status === 'fulfilled') {
      const feats = (m.value.features || []).map((f) => ({ ...f, properties: { ...(f.properties || {}), kind: 'mcd' } }));
      this.setData('mcd', { type: 'FeatureCollection', features: feats });
    }
    if (w.status === 'rejected' && m.status === 'rejected') throw w.reason;
  }

  async loadSpc() {
    const d = await getJSON('https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson');
    for (const f of d.features || []) f.properties = { ...f.properties, kind: 'spc' };
    this.setData('spc', d);
  }

  // ---------------------------------------------------------------- storm cells

  async loadStorms() {
    const d = await getJSON(`${IEM}/geojson/nexrad_attr.geojson`);
    this.allStorms = d.features || [];
    this.filterStorms();
  }

  /** Mean storm motion (toward) for the current radar, m/s east and north. */
  meanMotion() {
    const cells = this.cells || [];
    if (!cells.length) return null;
    let u = 0, v = 0, w = 0;
    for (const c of cells) {
      const p = c.properties;
      if (!(p.sknt > 0)) continue;
      const weight = 1 + Math.max(0, (p.max_dbz || 0) - 30) / 10;
      const to = ((p.drct + 180) * Math.PI) / 180;
      const ms = p.sknt / 1.943844;
      u += ms * Math.sin(to) * weight;
      v += ms * Math.cos(to) * weight;
      w += weight;
    }
    if (!w) return null;
    return { u: u / w, v: v / w, n: cells.length };
  }

  filterStorms() {
    const site = this.app.site?.l3;
    const core = this.app.core;
    const cells = (this.allStorms || []).filter((f) => f.properties.nexrad === site);
    this.cells = cells;
    const points = [];
    const tracks = [];
    for (const f of cells) {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const tvs = hasTvs(p);
      const meso = mesoRank(p) >= 5;
      const hail = (p.posh || 0) >= 50 || (p.max_size || 0) >= 1;
      const color = tvs ? '#ff2d55' : meso ? '#ffcc00' : hail ? '#30d158' : '#c7ced9';
      const tags = [tvs && 'TVS', meso && 'MESO', (p.max_size || 0) >= 0.75 && `${p.max_size}"`].filter(Boolean).join(' ');
      points.push({ type: 'Feature', geometry: f.geometry, properties: { ...p, kind: 'storm', color, label: `${p.storm_id}${tags ? ' ' + tags : ''}` } });
      if (p.sknt > 0) {
        const to = (p.drct + 180) % 360;
        const line = [[lon, lat]];
        for (const min of [15, 30, 45, 60]) {
          const km = (p.sknt * 1.852 * min) / 60;
          const pt = core.destination(lat, lon, to, km);
          line.push(pt);
          tracks.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: { color, label: `${min}m` } });
        }
        tracks.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { color, id: p.storm_id } });
      }
    }
    this.setData('storms', { type: 'FeatureCollection', features: points });
    this.setData('tracks', { type: 'FeatureCollection', features: tracks });
    this.app.onStorms?.(cells);
  }

  /** Cells whose forecast track passes near a point within the next hour. */
  arrivals(lon, lat, radiusKm = 6) {
    const core = this.app.core;
    const out = [];
    for (const f of this.cells || []) {
      const p = f.properties;
      if (!(p.sknt > 0)) continue;
      const [clon, clat] = f.geometry.coordinates;
      // Work in a local flat frame around the cell (km east, km north).
      const rel = core.polar(clat, clon, 0, lat, lon);
      const ex = rel.ground * Math.sin((rel.az * Math.PI) / 180);
      const ny = rel.ground * Math.cos((rel.az * Math.PI) / 180);
      const to = ((p.drct + 180) * Math.PI) / 180;
      const kmh = p.sknt * 1.852;
      const dx = Math.sin(to), dy = Math.cos(to);
      const along = ex * dx + ny * dy;
      if (along < 0) continue;
      const cross = Math.abs(ex * dy - ny * dx);
      const minutes = (along / kmh) * 60;
      if (cross <= radiusKm && minutes <= 75) out.push({ cell: p, minutes, cross });
    }
    return out.sort((a, b) => a.minutes - b.minutes);
  }

  // ---------------------------------------------------------------- storm reports

  async loadReports() {
    const d = await getJSON(`${IEM}/geojson/lsr.php?hours=${this.s.reportHours || 12}`);
    const feats = (d.features || []).map((f) => {
      const p = f.properties;
      const t = LSR_TYPES[p.type] || [p.typetext || 'Report', '#aeaeb2', '•'];
      return { ...f, properties: { ...p, kind: 'lsr', color: t[1], glyph: t[2], typeName: t[0] } };
    }).filter((f) => f.properties.type !== 'J' && f.properties.type !== 'P');
    this.setData('lsr', { type: 'FeatureCollection', features: feats });
  }

  // ---------------------------------------------------------------- river gauges

  async loadGauges(force) {
    if (!this.s.overlays.rivers) return;
    const map = this.app.primaryMap;
    if (!map || map.getZoom() < 5) return;
    const b = map.getBounds();
    const pad = 0.5;
    const box = [b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad].map((v) => Math.round(v * 2) / 2);
    const key = box.join(',');
    if (!force && key === this.gaugeKey) return;
    this.gaugeKey = key;
    const q = `bbox.xmin=${box[0]}&bbox.ymin=${box[1]}&bbox.xmax=${box[2]}&bbox.ymax=${box[3]}&srid=EPSG_4326`;
    const d = await getJSON(`${NWPS}/gauges?${q}`);
    const feats = (d.gauges || []).map((g) => {
      const obs = g.status?.observed || {};
      const fc = g.status?.forecast || {};
      const cat = GAUGE_COLORS[fc.floodCategory] && rank(fc.floodCategory) > rank(obs.floodCategory) ? fc.floodCategory : obs.floodCategory;
      return {
        type: 'Feature', geometry: { type: 'Point', coordinates: [g.longitude, g.latitude] },
        properties: { kind: 'gauge', lid: g.lid, name: g.name, state: g.state?.abbreviation || '', cat: cat || 'unknown',
          color: GAUGE_COLORS[cat] || '#8e8e93', obs: obs.primary, unit: obs.primaryUnit, obsCat: obs.floodCategory, fcCat: fc.floodCategory, obsTime: obs.validTime },
      };
    });
    feats.sort((a, b) => rank(a.properties.cat) - rank(b.properties.cat));
    this.setData('gauges', { type: 'FeatureCollection', features: feats });
  }

  async gaugeDetail(lid) {
    if (this.gaugeCache.has(lid)) return this.gaugeCache.get(lid);
    const p = Promise.all([getJSON(`${NWPS}/gauges/${lid}`), getJSON(`${NWPS}/gauges/${lid}/stageflow`)]);
    this.gaugeCache.set(lid, p);
    p.catch(() => this.gaugeCache.delete(lid));
    setTimeout(() => this.gaugeCache.delete(lid), 10 * 60e3);
    return p;
  }

  // ---------------------------------------------------------------- rasters

  mosaicUrl() {
    return `${IEM}/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?v=${this.mosaicTime || 0}`;
  }

  async loadMosaicTime() {
    const d = await getJSON(`${IEM}/data/gis/images/4326/USCOMP/n0q_0.json`);
    const t = Date.parse(d.meta?.valid) / 1000;
    if (t && t !== this.mosaicTime) {
      const first = !this.mosaicTime;
      this.mosaicTime = t;
      if (!first) this.reinstallRaster('ov-mosaic');
      this.app.onMosaicTime?.(t);
    }
  }

  bumpMrms() {
    const stamp = Math.floor(Date.now() / 600e3);
    if (stamp !== this.mrmsStamp) {
      const first = this.mrmsStamp == null;
      this.mrmsStamp = stamp;
      if (!first && MRMS_LAYERS[this.s.overlays.mrms]) this.reinstallRaster('ov-mrms');
    }
  }

  satUrl() {
    if (!this.satTime) return null;
    const lon = this.app.primaryMap?.getCenter().lng ?? -95;
    const sat = lon < -112 ? 'GOES-West' : 'GOES-East';
    const t = new Date(this.satTime * 1000).toISOString().slice(0, 19) + 'Z';
    return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${sat}_ABI_Band13_Clean_Infrared/default/${t}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
  }

  async loadSatTime() {
    // GIBS publishes GOES frames every 10 minutes with some delay: probe back.
    const lon = this.app.primaryMap?.getCenter().lng ?? -95;
    const sat = lon < -112 ? 'GOES-West' : 'GOES-East';
    let t = Math.floor((Date.now() / 1000 - 20 * 60) / 600) * 600;
    for (let i = 0; i < 9; i++, t -= 600) {
      const iso = new Date(t * 1000).toISOString().slice(0, 19) + 'Z';
      const res = await fetch(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${sat}_ABI_Band13_Clean_Infrared/default/${iso}/GoogleMapsCompatible_Level6/3/3/2.png`);
      if (res.ok && (res.headers.get('content-type') || '').startsWith('image')) {
        if (t !== this.satTime) {
          this.satTime = t;
          this.reinstallRaster('ov-sat');
        }
        return;
      }
    }
    throw new Error('no recent GOES frame');
  }

  lightningUrl() {
    return `${NOWCOAST}?service=WMS&version=1.3.0&request=GetMap&layers=lightning_detection:ldn_lightning_strike_density&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true&v=${this.ltgStamp || 0}`;
  }

  bumpLightning(force) {
    const stamp = Math.floor(Date.now() / 300e3);
    if (stamp === this.ltgStamp && !force) return;
    const first = this.ltgStamp == null;
    this.ltgStamp = stamp;
    if (!first || force) {
      for (const map of this.maps) {
        const src = map.getSource('ov-lightning');
        if (src?.setTiles) src.setTiles([this.lightningUrl()]);
      }
    }
  }

  /** Active storms from the National Hurricane Center. Returns how many storms are active. */
  async loadTropical() {
    if (!this.nhcIds) {
      const d = await getJSON(`${NHC}?f=json`);
      const slots = {};
      const misc = {};
      for (const l of d.layers || []) {
        const m = l.name.match(/^([A-Z]{2}\d) (Forecast Points|Forecast Track|Forecast Cone|Watch-Warning|Past Track)$/);
        if (m) (slots[m[1]] ||= {})[m[2]] = l.id;
        if (/^Seven-Day: Potential Development Region$/i.test(l.name)) misc.area = l.id;
        if (/^Seven-Day: Current Location$/i.test(l.name)) misc.where = l.id;
      }
      this.nhcIds = { slots, misc };
    }
    const q = (id) => getJSON(`${NHC}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson`);
    const { slots, misc } = this.nhcIds;
    const names = Object.keys(slots).filter((k) => slots[k]['Forecast Cone'] != null);
    const cones = await Promise.allSettled(names.map((k) => q(slots[k]['Forecast Cone'])));
    const active = names.filter((k, i) => cones[i].status === 'fulfilled' && cones[i].value.features?.length);
    const cone = [], ww = [], lines = [], pts = [];
    for (const [i, k] of names.entries()) if (active.includes(k)) cone.push(...cones[i].value.features.map((f) => ({ ...f, properties: { ...f.properties, kind: 'trop-cone' } })));
    await Promise.all(active.map(async (k) => {
      const s = slots[k];
      const [p, t, past, w] = await Promise.allSettled([q(s['Forecast Points']), q(s['Forecast Track']), q(s['Past Track']), q(s['Watch-Warning'])]);
      if (p.status === 'fulfilled') for (const f of p.value.features || []) {
        const x = f.properties;
        const kt = +pick(x, 'MAXWIND', 'INTENSITY') || 0;
        const cat = tropicalCategory(kt, pick(x, 'STORMTYPE', 'TCDVLP'));
        pts.push({ ...f, properties: { ...x, kind: 'trop-pt', color: cat.color, short: cat.short, catName: cat.name, kt, when: pick(x, 'FLDATELBL', 'DATELBL') || '' } });
      }
      if (t.status === 'fulfilled') for (const f of t.value.features || []) lines.push({ ...f, properties: { ...f.properties, past: false } });
      if (past.status === 'fulfilled') for (const f of past.value.features || []) lines.push({ ...f, properties: { ...f.properties, past: true } });
      if (w.status === 'fulfilled') for (const f of w.value.features || []) {
        const code = String(pick(f.properties, 'TCWW') || '').toUpperCase();
        const [label, color] = TC_WW[code] || ['Tropical watch/warning', '#ffd60a'];
        ww.push({ ...f, properties: { ...f.properties, kind: 'trop-ww', label, color } });
      }
    }));
    const outlook = [];
    if (misc.area != null) {
      try {
        const a = await q(misc.area);
        for (const f of a.features || []) {
          const x = f.properties;
          const p7 = parseInt(pick(x, 'PROB7DAY', 'PROB7') || '0', 10);
          const color = p7 >= 60 ? '#ff453a' : p7 >= 40 ? '#ff9f0a' : '#ffd60a';
          outlook.push({ ...f, properties: { ...x, kind: 'trop-outlook', color } });
        }
      } catch { /* outlook optional */ }
    }
    this.setData('trop-cone', { type: 'FeatureCollection', features: cone });
    this.setData('trop-ww', { type: 'FeatureCollection', features: ww });
    this.setData('trop-line', { type: 'FeatureCollection', features: lines });
    this.setData('trop-pts', { type: 'FeatureCollection', features: pts });
    this.setData('trop-outlook', { type: 'FeatureCollection', features: outlook });
    this.tropicalActive = active.length;
    return active.length;
  }

  // ---------------------------------------------------------------- sites & rings

  setSites() {
    const cur = this.app.site?.id;
    this.setData('sites', {
      type: 'FeatureCollection',
      features: this.app.sites.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { kind: 'site', id: s.id, name: s.name, current: s.id === cur } })),
    });
  }

  setRings() {
    const site = this.app.site;
    if (!site) return;
    const u = this.s.units.distance;
    const stepKm = u === 'km' ? 50 : u === 'nm' ? 25 * 1.852 : 25 * 1.609344;
    const feats = [];
    const core = this.app.core;
    for (let i = 1; i * stepKm <= 465; i++) {
      const km = i * stepKm;
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: circle(site.lon, site.lat, km, core) }, properties: { kind: 'ring' } });
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: core.destination(site.lat, site.lon, 0, km) }, properties: { kind: 'label', label: fmtU(distance(km, u)) } });
    }
    for (let a = 0; a < 360; a += 30) {
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[site.lon, site.lat], core.destination(site.lat, site.lon, a, 460)] }, properties: { kind: 'spoke' } });
    }
    this.setData('rings', { type: 'FeatureCollection', features: feats });
  }

  // ---------------------------------------------------------------- descriptions

  describe(f) {
    const p = f.properties;
    const U = this.s.units;
    if (p.kind === 'warning') {
      const tags = [];
      if (p.threat) tags.push(`<span class="tag ${p.emph ? 'hot' : ''}">${esc(p.threat)} damage threat</span>`);
      if (p.detection) tags.push(`<span class="tag ${p.detection === 'OBSERVED' ? 'hot' : ''}">${esc(p.detection)}</span>`);
      if (p.hail) tags.push(`<span class="tag">Hail ${esc(p.hail)}"</span>`);
      if (p.wind) tags.push(`<span class="tag">Wind ${esc(p.wind)}</span>`);
      return {
        title: p.emph === 2 && p.key === 'TOR' ? 'TORNADO EMERGENCY' : p.event,
        color: p.color,
        html: `<p class="meta">${esc(p.sender)} · until ${esc(dateTime(Date.parse(p.expires) / 1000, this.s.utc))}</p>
          ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
          <p class="area">${esc(p.area)}</p>
          <pre class="bulletin">${esc(p.description)}</pre>
          ${p.instruction ? `<h4>What to do</h4><pre class="bulletin">${esc(p.instruction)}</pre>` : ''}`,
      };
    }
    if (p.kind === 'storm') {
      const mv = p.sknt > 0 ? `${compass((p.drct + 180) % 360)} at ${fmtU(knotsTo(p.sknt, U.speed))}` : 'Stationary';
      const rows = [
        ['Moving', mv],
        ['Max reflectivity', `${p.max_dbz} dBZ at ${fmtU(height(p.max_dbz_height * 0.3048, U.height))}`],
        ['Storm top', fmtU(height(p.top * 0.3048, U.height))],
        ['VIL', `${p.vil} kg/m²`],
        ['Hail probability', `${p.poh}% (severe ${p.posh}%)`],
        ['Max hail size', p.max_size >= 0.25 ? `${fmt(p.max_size, 2)} in` : '—'],
        ['Rotation', mesoRank(p) >= 5 ? `Mesocyclone (strength rank ${mesoRank(p)})` : mesoRank(p) > 0 ? `Weak circulation (rank ${mesoRank(p)})` : 'None detected'],
        ['Tornado vortex sig.', hasTvs(p) ? esc(p.tvs) : 'No'],
      ];
      return {
        title: `Storm cell ${esc(p.storm_id)}`, color: p.color,
        html: `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
          <p class="note">From the radar’s storm cell identification and tracking (SCIT) at ${esc(dateTime(Date.parse(p.valid) / 1000, this.s.utc))}. Track ticks every 15 minutes assume the cell keeps its current motion.</p>`,
      };
    }
    if (p.kind === 'lsr') {
      const mag = p.magf ? `${fmt(p.magf, p.type === 'H' ? 2 : 0)} ${esc(p.unit || '')}` : '';
      return {
        title: `${esc(p.typeName)}${mag ? ' · ' + mag : ''}`, color: p.color,
        html: `<p class="meta">${esc(p.city)}, ${esc(p.county)} Co., ${esc(p.state)} · ${esc(dateTime(Date.parse(p.valid) / 1000, this.s.utc))}</p>
          <p>${esc(p.remark || '')}</p><p class="note">Source: ${esc(p.source || 'NWS')} via NWS ${esc(p.wfo)} local storm report.</p>`,
      };
    }
    if (p.kind === 'watch') {
      return { title: p.label, color: p.color, html: `<p class="meta">Expires ${esc(p.expire ? dateTime(Date.parse(p.expire) / 1000, this.s.utc) : '—')}</p><p class="note">Storm Prediction Center watch.</p>` };
    }
    if (p.kind === 'mcd') {
      const url = p.spcurl || p.url;
      return { title: `Mesoscale Discussion ${esc(p.product_num ?? p.num ?? '')}`, color: '#4aa3ff',
        html: `<p>${esc(p.concerning || '')}</p>${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">Read the discussion at SPC</a></p>` : ''}` };
    }
    if (p.kind === 'spc') {
      return { title: `SPC Day 1: ${esc(p.LABEL2 || p.LABEL || '')}`, color: p.fill || '#888', html: `<p class="note">Storm Prediction Center convective outlook.</p>` };
    }
    if (p.kind === 'trop-pt') {
      const name = pick(p, 'STORMNAME') || '';
      const rows = [
        ['When', esc(p.when || pick(p, 'ADVDATE') || '—')],
        ['Strength', esc(p.catName)],
        ['Max wind', p.kt ? fmtU(knotsTo(p.kt, U.speed)) : '—'],
        ['Gusts', pick(p, 'GUST') ? fmtU(knotsTo(+pick(p, 'GUST'), U.speed)) : '—'],
        ['Pressure', pick(p, 'MSLP') && +pick(p, 'MSLP') < 9000 ? `${pick(p, 'MSLP')} mb` : '—'],
      ];
      return { title: `${esc(pick(p, 'TCDVLP') || p.catName)} ${esc(name)}`.trim(), color: p.color,
        html: `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
          <p class="note">National Hurricane Center forecast${pick(p, 'ADVISNUM') ? `, advisory ${esc(pick(p, 'ADVISNUM'))}` : ''}. <a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">Latest from NHC</a></p>` };
    }
    if (p.kind === 'trop-cone') {
      return { title: `Forecast cone${pick(p, 'STORMNAME') ? ': ' + esc(pick(p, 'STORMNAME')) : ''}`, color: '#ffffff',
        html: `<p>The center of the storm will probably stay inside this cone over the next five days.</p>
          <p class="note">Dangerous wind, rain, flooding and storm surge often reach far outside the cone. Follow local officials and the <a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">National Hurricane Center</a>.</p>` };
    }
    if (p.kind === 'trop-ww') {
      return { title: esc(p.label), color: p.color, html: '<p class="note">Coastal tropical watch or warning from the National Hurricane Center.</p>' };
    }
    if (p.kind === 'trop-outlook') {
      const p2 = pick(p, 'PROB2DAY', 'PROB2') || '—';
      const p7 = pick(p, 'PROB7DAY', 'PROB7') || '—';
      return { title: 'Possible tropical development', color: p.color,
        html: `<table class="kv"><tr><th>Chance in 2 days</th><td>${esc(p2)}</td></tr><tr><th>Chance in 7 days</th><td>${esc(p7)}</td></tr></table>
          <p class="note">Area the National Hurricane Center is watching for a tropical storm or hurricane to form.</p>` };
    }
    if (p.kind === 'site') {
      return { title: `${esc(p.id)} · ${esc(p.name)}`, color: '#3d8bff', html: '' };
    }
    return null;
  }

  async gaugeHtml(p) {
    const [meta, sf] = await this.gaugeDetail(p.lid);
    const U = this.s.units;
    const cats = meta.flood?.categories || {};
    const unit = meta.flood?.stageUnits || 'ft';
    const obs = (sf.observed?.data || []).filter((d) => d.primary > -999).map((d) => [Date.parse(d.validTime) / 1000, d.primary]);
    const fc = (sf.forecast?.data || []).filter((d) => d.primary > -999).map((d) => [Date.parse(d.validTime) / 1000, d.primary]);
    const cut = Date.now() / 1000 - 3 * 86400;
    const o = obs.filter((d) => d[0] >= cut);
    const chart = hydrograph(o, fc, cats, unit, this.s.utc);
    const latest = o[o.length - 1];
    const crest = meta.flood?.crests?.historic?.[0];
    const rows = [
      ['Latest', latest ? `${fmt(latest[1], 2)} ${unit} · ${dateTime(latest[0], this.s.utc)}` : '—'],
      ['Status now', GAUGE_LABEL[p.obsCat] || '—'],
      ['Forecast', GAUGE_LABEL[p.fcCat] || (fc.length ? '—' : 'No forecast issued')],
      ...['action', 'minor', 'moderate', 'major'].filter((k) => cats[k]?.stage > -999).map((k) => [`${k[0].toUpperCase()}${k.slice(1)} stage`, `${fmt(cats[k].stage, 1)} ${unit}`]),
      ...(crest ? [['Record crest', `${fmt(crest.stage, 2)} ${unit} (${new Date(crest.occurredTime).getUTCFullYear()})`]] : []),
    ];
    void U;
    return `<p class="meta">${esc(p.lid)} · ${esc(meta.rfc?.abbreviation || '')} · ${esc(meta.county || '')}${meta.state?.abbreviation ? ', ' + esc(meta.state.abbreviation) : ''}</p>
      ${chart}
      <table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
      <p class="note">Observations and river forecasts from the National Water Prediction Service. <a href="https://water.noaa.gov/gauges/${esc(p.lid)}" target="_blank" rel="noopener">Open on water.noaa.gov</a></p>`;
  }
}

function rank(cat) {
  return { major: 5, moderate: 4, minor: 3, action: 2, no_flooding: 1 }[cat] || 0;
}

/** Small SVG stage hydrograph: observed (solid), forecast (dashed), flood stages. */
export function hydrograph(obs, fc, cats, unit, utc) {
  const all = obs.concat(fc);
  if (all.length < 2) return '<p class="note">No recent stage data.</p>';
  const W = 320, H = 150, L = 38, R = 8, T = 10, B = 22;
  const t0 = all[0][0], t1 = all[all.length - 1][0];
  const levels = ['action', 'minor', 'moderate', 'major'].map((k) => [k, cats[k]?.stage]).filter(([, v]) => v > -999);
  const vals = all.map((d) => d[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const near = levels.filter(([, v]) => v < hi + (hi - lo + 1) * 1.5);
  for (const [, v] of near) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (d) => d.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const lc = { action: GAUGE_COLORS.action, minor: GAUGE_COLORS.minor, moderate: GAUGE_COLORS.moderate, major: GAUGE_COLORS.major };
  const grid = [];
  const dec = hi - lo < 1.5 ? 2 : hi - lo < 15 ? 1 : 0;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(dec)}</text>`);
  }
  const days = [];
  for (let t = Math.ceil(t0 / 86400) * 86400; t < t1; t += 86400) {
    const d = new Date(t * 1000);
    const lab = utc ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    days.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" class="g"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${lab}</text>`);
  }
  const now = Date.now() / 1000;
  return `<svg class="hydro" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stage hydrograph in ${unit}">
    ${grid.join('')}${days.join('')}
    ${near.map(([k, v]) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${lc[k]}" stroke-width="1.2" stroke-dasharray="5 3"/>`).join('')}
    ${now > t0 && now < t1 ? `<line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${H - B}" class="now"/>` : ''}
    ${obs.length > 1 ? `<path d="${path(obs)}" class="obs"/>` : ''}
    ${fc.length > 1 ? `<path d="${path(obs.length ? [obs[obs.length - 1], ...fc] : fc)}" class="fc"/>` : ''}
    <text x="${L}" y="${T - 1}" class="u">${unit}</text>
  </svg>
  <div class="hydro-key"><span><i class="k-obs"></i>Observed</span>${fc.length ? '<span><i class="k-fc"></i>Forecast</span>' : ''}${near.map(([k]) => `<span><i style="background:${lc[k]}"></i>${k}</span>`).join('')}</div>`;
}

export { esc, rain };
