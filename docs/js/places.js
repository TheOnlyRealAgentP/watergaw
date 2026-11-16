// Place search and plain-language "what's happening here" summaries.

import { sampleSweep } from './nexrad.js';
import * as U from './units.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** Search places and addresses (OpenStreetMap data via Photon, Nominatim as backup). */
export async function searchPlaces(q, near) {
  const query = q.trim();
  if (query.length < 2) return [];
  try {
    const p = new URLSearchParams({ q: query, limit: '8', lang: 'en' });
    if (near) { p.set('lat', near.lat.toFixed(2)); p.set('lon', near.lng.toFixed(2)); }
    const res = await fetch(`${PHOTON}?${p}`);
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    return d.features.map((f) => {
      const x = f.properties;
      const name = x.name || [x.housenumber, x.street].filter(Boolean).join(' ') || x.city || x.county || 'Place';
      const detail = [x.name && x.street && `${x.housenumber || ''} ${x.street}`.trim(), x.city !== name && x.city, x.county && !x.city && x.county, x.state, x.country !== 'United States' && x.country]
        .filter(Boolean).join(', ');
      return { name, detail, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    });
  } catch {
    const p = new URLSearchParams({ q: query, format: 'json', limit: '8', addressdetails: '1' });
    const res = await fetch(`${NOMINATIM}?${p}`);
    const d = await res.json();
    return d.map((x) => ({ name: x.display_name.split(',')[0], detail: x.display_name.split(',').slice(1, 4).join(',').trim(), lat: +x.lat, lon: +x.lon }));
  }
}

export function intensityWord(dbz) {
  if (!(dbz >= 20)) return null;
  if (dbz < 30) return 'Light';
  if (dbz < 40) return 'Moderate';
  if (dbz < 50) return 'Heavy';
  if (dbz < 58) return 'Very heavy';
  return 'Intense';
}

/** Strongest value of a sweep within ~1 km of a point (dBZ), or null outside coverage. */
export function sampleNear(core, sweep, lat, lon) {
  if (!sweep) return null;
  const m = sweep.meta;
  let best = -99;
  let covered = false;
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const la = lat + dy / 111;
    const lo = lon + dx / (111 * Math.cos((lat * Math.PI) / 180));
    const pol = core.polar(m.lat, m.lon, m.elevation, la, lo);
    if (pol.slant > m.first_gate_km + m.gates * m.gate_km) continue;
    covered = true;
    const r = sampleSweep(sweep, pol.az, pol.slant);
    if (r.flag === 0 && r.value > best) best = r.value;
  }
  return covered ? best : null;
}

/** Precip type from a hydrometeor-class sweep at a point. */
export function precipType(core, hc, lat, lon) {
  if (!hc) return 'rain';
  const m = hc.meta;
  const pol = core.polar(m.lat, m.lon, m.elevation, lat, lon);
  const r = sampleSweep(hc, pol.az, pol.slant);
  if (r.flag !== 0) return 'rain';
  const c = Math.round(r.value);
  if (c === 3 || c === 4 || c === 5) return 'snow';
  if (c >= 9 && c <= 12) return 'hail';
  return 'rain';
}

/**
 * Summary for one point.
 * ctx: { core, now, hc, forecast: [{ lead, sweep }], warnings, arrivals, utc, siteId, siteKm }
 * Returns { level, headline, lines[], bars[] } where level is danger | warn | rain | soon | clear | far.
 */
export function summarize(lat, lon, ctx) {
  const lines = [];
  let level = 'clear';
  const clock = (t) => U.clock(t, ctx.utc);
  for (const w of ctx.warnings) {
    const p = w.properties;
    const name = p.emph === 2 && p.key === 'TOR' ? 'TORNADO EMERGENCY' : p.event;
    lines.push({ cls: p.key === 'TOR' ? 'tor' : p.key === 'FFW' ? 'ffw' : 'svr', text: `${name} until ${clock(Date.parse(p.expires) / 1000)}`, warning: w });
    level = 'danger';
  }
  const nowV = sampleNear(ctx.core, ctx.now, lat, lon);
  if (nowV == null) {
    return { level: level === 'danger' ? level : 'far', headline: level === 'danger' ? lines[0].text : `Outside ${ctx.siteId}'s range`, lines: level === 'danger' ? lines.slice(1) : lines, bars: [] };
  }
  const type = precipType(ctx.core, ctx.hc, lat, lon);
  const word = (v) => `${intensityWord(v)} ${type === 'hail' ? 'rain and hail' : type}`;
  const bars = [{ label: 'Now', v: nowV, t: ctx.now.meta.scan_time }];
  for (const f of ctx.forecast) bars.push({ label: `+${Math.round(f.lead / 60)}`, v: sampleNear(ctx.core, f.sweep, lat, lon) ?? -99, t: f.sweep.meta.scan_time, fc: true });
  let headline;
  const future = bars.slice(1);
  if (nowV >= 20) {
    const stop = future.findIndex((b, i) => future.slice(i).every((x) => x.v < 20));
    headline = `${word(nowV)} now`;
    if (future.length) headline += stop >= 0 ? `, easing around ${clock(future[stop].t)}` : ', for at least the next hour';
    if (level !== 'danger') level = nowV >= 45 ? 'warn' : 'rain';
  } else {
    const first = future.find((b) => b.v >= 20);
    if (first) {
      const peak = Math.max(...future.map((b) => b.v));
      const mins = Math.max(5, Math.round((first.t - Date.now() / 1000) / 60 / 5) * 5);
      headline = `${word(peak)} likely around ${clock(first.t)} (in about ${mins} min)`;
      if (level !== 'danger') level = 'soon';
    } else {
      headline = future.length ? `No ${type} expected in the next hour` : `No ${type} right now`;
    }
  }
  for (const a of ctx.arrivals.slice(0, 2)) {
    const c = a.cell;
    const tags = [c.tvs && c.tvs !== 'NONE' && 'tornado signature', parseInt(c.meso, 10) >= 5 && 'rotation', c.max_size >= 0.75 && `${c.max_size}" hail`].filter(Boolean).join(', ');
    if (tags) lines.push({ cls: 'cell', text: `Storm ${c.storm_id} reaches here in ~${Math.max(1, Math.round(a.minutes))} min (${tags})`, cell: c });
  }
  if (level === 'danger') return { level, headline: lines[0].text, lines: [{ cls: level, text: headline }, ...lines.slice(1)], bars };
  return { level, headline, lines, bars };
}
