// Basemap styles tuned for radar: muted land and water, radar drawn under
// roads, county lines and labels so geography stays readable through storms.

const OMT = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** Layer ids the app inserts its own layers in front of. */
export const ANCHOR_RADAR = 'road-minor';
export const ANCHOR_OVERLAY = 'label-place-other';

/** Phones and tablets are read at arm's length: place names a little bigger. */
const LABEL = globalThis.matchMedia?.('(pointer: coarse)').matches ? 1.15 : 1;
const px = (n) => Math.round(n * LABEL * 10) / 10;

/** A layer's layout with its text-size (a number or a zoom ramp) scaled like the place names. */
export function labelSize(layout) {
  const t = layout?.['text-size'];
  if (LABEL === 1 || t == null) return layout;
  const size = typeof t === 'number' ? px(t)
    : Array.isArray(t) && t[0] === 'interpolate' ? [...t.slice(0, 3), ...t.slice(3).map((v, i) => (i % 2 ? px(v) : v))]
    : t;
  return { ...layout, 'text-size': size };
}

const THEMES = {
  dark: {
    bg: '#0b0e13', water: '#101b27', land: '#10141a', park: '#111a16', waterway: '#16283a',
    road: 'rgba(170,180,195,0.22)', motorway: 'rgba(200,190,160,0.32)', county: 'rgba(160,170,185,0.28)',
    state: 'rgba(205,212,225,0.62)', country: 'rgba(225,230,240,0.8)',
    text: '#d9dee7', halo: 'rgba(5,8,12,0.9)', textMinor: '#a7b0bd',
  },
  light: {
    bg: '#eef1f4', water: '#c8d7e6', land: '#e7ebef', park: '#dfe8df', waterway: '#b7cde2',
    road: 'rgba(90,100,115,0.28)', motorway: 'rgba(150,110,60,0.45)', county: 'rgba(70,80,95,0.3)',
    state: 'rgba(40,48,60,0.62)', country: 'rgba(20,25,35,0.8)',
    text: '#1d2430', halo: 'rgba(255,255,255,0.92)', textMinor: '#3d4655',
  },
  satellite: {
    bg: '#000', water: 'rgba(0,0,0,0)', land: 'rgba(0,0,0,0)', park: 'rgba(0,0,0,0)', waterway: 'rgba(0,0,0,0)',
    road: 'rgba(255,255,255,0.25)', motorway: 'rgba(255,230,170,0.42)', county: 'rgba(255,255,255,0.3)',
    state: 'rgba(255,255,255,0.7)', country: 'rgba(255,255,255,0.85)',
    text: '#ffffff', halo: 'rgba(0,0,0,0.85)', textMinor: '#e6e6e6',
  },
};

const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']];

export function buildStyle(theme = 'dark') {
  const t = THEMES[theme] || THEMES.dark;
  const sources = { omt: { type: 'vector', url: OMT, attribution: '© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap' } };
  const layers = [{ id: 'background', type: 'background', paint: { 'background-color': t.bg } }];
  if (theme === 'satellite') {
    sources.imagery = { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' };
    layers.push({ id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-brightness-max': 0.72, 'raster-saturation': -0.25 } });
  } else {
    layers.push(
      { id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'grass']]], paint: { 'fill-color': t.park, 'fill-opacity': 0.5 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': t.park, 'fill-opacity': 0.6 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': t.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 7, filter: ['in', ['get', 'class'], ['literal', ['river', 'canal']]],
        paint: { 'line-color': t.waterway, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 12, 2] } },
    );
  }
  layers.push(
    { id: ANCHOR_RADAR, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10,
      filter: ['in', ['get', 'class'], ['literal', ['minor', 'tertiary', 'secondary']]],
      paint: { 'line-color': t.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 16, 2.5] } },
    { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 6,
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'trunk']]],
      paint: { 'line-color': t.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 3] } },
    { id: 'road-motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 5,
      filter: ['==', ['get', 'class'], 'motorway'],
      paint: { 'line-color': t.motorway, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 14, 3.5] } },
    { id: 'boundary-county', type: 'line', source: 'counties', minzoom: 5.5,
      paint: { 'line-color': t.county, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 1.4] } },
    { id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': t.state, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.7, 10, 2] } },
    { id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': t.country, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 10, 2.5] } },
    { id: ANCHOR_OVERLAY, type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 8.5,
      filter: ['in', ['get', 'class'], ['literal', ['town', 'village']]],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 9, px(11), 14, px(14)], 'text-max-width': 8 },
      paint: { 'text-color': t.textMinor, 'text-halo-color': t.halo, 'text-halo-width': 1.4 } },
    { id: 'label-city', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4.5,
      filter: ['==', ['get', 'class'], 'city'],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 5, px(11), 12, px(16)], 'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 1.6 } },
    { id: 'label-state', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 3, maxzoom: 6.5,
      filter: ['==', ['get', 'class'], 'state'],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': px(11), 'text-transform': 'uppercase', 'text-letter-spacing': 0.12 },
      paint: { 'text-color': t.textMinor, 'text-halo-color': t.halo, 'text-halo-width': 1.2, 'text-opacity': 0.8 } },
  );
  sources.counties = { type: 'geojson', data: 'data/counties.geojson', attribution: 'Counties: US Census Bureau' };
  return { version: 8, glyphs: GLYPHS, sources, layers, projection: { type: 'mercator' } };
}
