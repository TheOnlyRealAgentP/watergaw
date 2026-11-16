// RouteCast: the weather you'll drive into, at the time you'll get there.
//
// OSRM gives the driving route and the time to each point along it. We sample
// points along the way, and for each one take the National Weather Service
// hourly forecast for the hour you'll arrive, active warnings there, and (in
// the next hour) the radar nowcast.

import * as U from './units.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const NWS = 'https://api.weather.gov';
const hourlyCache = new Map();

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

function hoursOf(dur) {
  const m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  return m ? (+(m[1] || 0)) * 24 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60 : 1;
}

/** Hourly NWS grid values for a point: { place, at(t) -> { temp, pop, qpf, snow, wind, gust } }. */
export async function loadHourly(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = hourlyCache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60e3) return hit.v;
  const pt = (await getJSON(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).properties;
  const g = (await getJSON(pt.forecastGridData)).properties;
  const series = (s, amount = false) => (s?.values || []).map((v) => {
    const [start, dur] = v.validTime.split('/');
    const h = Math.max(1, hoursOf(dur));
    const t0 = Date.parse(start) / 1000;
    return { t0, t1: t0 + h * 3600, v: v.value == null ? null : amount ? v.value / h : v.value };
  });
  const S = { temp: series(g.temperature), pop: series(g.probabilityOfPrecipitation), qpf: series(g.quantitativePrecipitation, true),
    snow: series(g.snowfallAmount, true), wind: series(g.windSpeed), gust: series(g.windGust) };
  const pick = (arr, t) => arr.find((x) => t >= x.t0 && t < x.t1)?.v ?? null;
  const v = {
    place: [pt.relativeLocation?.properties?.city, pt.relativeLocation?.properties?.state].filter(Boolean).join(', '),
    at: (t) => Object.fromEntries(Object.entries(S).map(([k, arr]) => [k, pick(arr, t)])),
  };
  hourlyCache.set(key, { t: Date.now(), v });
  return v;
}

function haversineKm(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch { out[k] = null; }
    }
  }));
  return out;
}

/**
 * Plan a drive. ctx: { warningsAt(lon, lat) -> features, radarAt(lat, lon, eta) -> dBZ|null }.
 * Returns { coords, km, seconds, depart, samples: [{ lon, lat, km, eta, place, wx, warnings, dbz, level }] }.
 */
export async function planDrive(from, to, depart, ctx) {
  const url = `${OSRM}/${from.lon.toFixed(5)},${from.lat.toFixed(5)};${to.lon.toFixed(5)},${to.lat.toFixed(5)}?overview=full&geometries=geojson&annotations=duration`;
  const d = await getJSON(url);
  if (d.code !== 'Ok' || !d.routes?.length) throw new Error('No driving route found between those places.');
  const r = d.routes[0];
  const coords = r.geometry.coordinates;
  const durs = r.legs.flatMap((l) => l.annotation?.duration || []);
  const cumT = [0], cumKm = [0];
  for (let i = 1; i < coords.length; i++) {
    cumT.push(cumT[i - 1] + (durs[i - 1] ?? 0));
    cumKm.push(cumKm[i - 1] + haversineKm(coords[i - 1], coords[i]));
  }
  // Scale segment times so they add up to OSRM's total.
  const f = r.duration / (cumT[cumT.length - 1] || r.duration);
  const totalKm = cumKm[cumKm.length - 1];
  const n = Math.max(2, Math.min(12, Math.ceil(totalKm / 35) + 1));
  const picks = [];
  for (let s = 0; s < n; s++) {
    const target = (s / (n - 1)) * totalKm;
    let i = cumKm.findIndex((k) => k >= target);
    if (i < 0) i = coords.length - 1;
    picks.push({ lon: coords[i][0], lat: coords[i][1], km: cumKm[i], eta: depart + cumT[i] * f, idx: i });
  }
  const wx = await pool(picks, 4, (p) => loadHourly(p.lat, p.lon));
  const samples = picks.map((p, k) => {
    const h = wx[k];
    const w = h ? h.at(p.eta) : null;
    const warnings = ctx.warningsAt(p.lon, p.lat).filter((x) => Date.parse(x.properties.expires) / 1000 > p.eta);
    const dbz = ctx.radarAt(p.lat, p.lon, p.eta);
    let level = 'ok';
    const snowy = w && (w.snow > 0.2 || (w.temp != null && w.temp <= 0.5 && (w.pop || 0) >= 40));
    if ((w?.pop || 0) >= 30 || dbz >= 20) level = 'some';
    if ((w?.pop || 0) >= 60 || dbz >= 35 || snowy || (w?.gust || 0) >= 64) level = 'bad';
    if (warnings.length) level = 'warn';
    return { ...p, place: h?.place || '', wx: w, warnings, dbz, level, snowy };
  });
  return { coords, km: totalKm, seconds: r.duration, depart, samples };
}

export const LEVEL_COLOR = { ok: '#34c759', some: '#ffd60a', bad: '#ff9f0a', warn: '#ff3b30' };

/** Route line split into colored segments between samples. */
export function routeGeoJSON(plan) {
  const feats = [];
  const rank = { ok: 0, some: 1, bad: 2, warn: 3 };
  for (let k = 0; k < plan.samples.length - 1; k++) {
    const a = plan.samples[k], b = plan.samples[k + 1];
    const lvl = rank[a.level] >= rank[b.level] ? a.level : b.level;
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: plan.coords.slice(a.idx, b.idx + 1) }, properties: { color: LEVEL_COLOR[lvl] } });
  }
  plan.samples.forEach((s, k) => feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: { kind: 'route-pt', i: k, color: LEVEL_COLOR[s.level], label: k === 0 ? 'Start' : k === plan.samples.length - 1 ? 'Arrive' : '' } }));
  return { type: 'FeatureCollection', features: feats };
}

/** One-line conditions for a sample. */
export function describe(s, units) {
  const w = s.wx;
  if (!w) return 'No forecast for this spot';
  const t = w.temp == null ? '' : `${Math.round(units.temp === 'C' ? w.temp : w.temp * 9 / 5 + 32)}°`;
  const pop = w.pop ?? 0;
  let what = pop >= 60 ? (s.snowy ? 'Snow likely' : 'Rain likely') : pop >= 30 ? (s.snowy ? 'Chance of snow' : 'Chance of rain') : 'Dry';
  if (s.dbz >= 35) what = 'Heavy rain on radar';
  else if (s.dbz >= 20 && pop < 60) what = 'Rain on radar';
  const gust = w.gust != null && w.gust >= 40 ? `, gusts ${U.fmtU(U.speed(w.gust / 3.6, units.speed))}` : '';
  return `${what}${pop >= 20 ? ` (${pop}%)` : ''}${t ? ` · ${t}` : ''}${gust}`;
}

/** Chart of the drive: rain/snow chance bars and temperature over travel time. */
export function driveChart(plan, units, utc) {
  const W = 340, H = 120, L = 30, R = 8, T = 8, B = 18;
  const s = plan.samples;
  const t0 = plan.depart, t1 = plan.depart + plan.seconds;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const temps = s.map((p) => (p.wx?.temp == null ? null : units.temp === 'C' ? p.wx.temp : p.wx.temp * 9 / 5 + 32));
  const tv = temps.filter((v) => v != null);
  const lo = tv.length ? Math.floor(Math.min(...tv) / 5) * 5 - 5 : 0, hi = tv.length ? Math.ceil(Math.max(...tv) / 5) * 5 + 5 : 100;
  const yT = (v) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const yP = (p) => T + (1 - p / 100) * (H - T - B);
  const bw = Math.max(6, (W - L - R) / s.length * 0.6);
  const bars = s.map((p) => `<rect x="${x(p.eta) - bw / 2}" y="${yP(p.wx?.pop || 0)}" width="${bw}" height="${H - B - yP(p.wx?.pop || 0)}" fill="${LEVEL_COLOR[p.level]}" opacity="0.55"/>`).join('');
  let path = '';
  temps.forEach((v, k) => { if (v != null) path += `${path ? 'L' : 'M'}${x(s[k].eta).toFixed(1)},${yT(v).toFixed(1)}`; });
  const ticks = [0, 0.5, 1].map((f) => {
    const t = t0 + f * (t1 - t0);
    return `<text x="${x(t)}" y="${H - 4}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" class="hl">${U.clock(t, utc)}</text>`;
  }).join('');
  const grid = [0, 50, 100].map((p) => `<line x1="${L}" x2="${W - R}" y1="${yP(p)}" y2="${yP(p)}" class="g"/><text x="${L - 4}" y="${yP(p) + 3}" text-anchor="end" class="yl">${p}%</text>`).join('');
  const warn = s.filter((p) => p.warnings.length).map((p) => `<text x="${x(p.eta)}" y="${T + 10}" text-anchor="middle" class="ann">⚠</text>`).join('');
  // Temperature labels on the line (the left axis is precipitation chance).
  const tlabels = temps.map((v, k) => (v == null ? '' : `<circle cx="${x(s[k].eta)}" cy="${yT(v)}" r="2.2" fill="#ff9f0a"/><text x="${x(s[k].eta)}" y="${yT(v) - 5}" text-anchor="middle" class="ann">${Math.round(v)}°</text>`)).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="fcsvg" role="img" aria-label="Weather along the drive">${grid}${bars}<path d="${path}" class="temp"/>${tlabels}${warn}${ticks}</svg>
    <div class="fc-h"><span><i class="k-pop"></i>Chance of rain/snow (colored by risk) <i class="k-temp"></i>Temperature</span></div>`;
}
