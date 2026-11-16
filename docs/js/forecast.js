// Point forecasts from the National Weather Service, drawn as charts.
//
// api.weather.gov/points -> the forecast office's grid cell -> hourly series
// (temperature, feels-like, precipitation chance and amount, snow, wind) and
// 12-hour periods. Alerts for the point are drawn as bands across the charts
// so upcoming weather events read at a glance.

import * as U from './units.js';

const NWS = 'https://api.weather.gov';
const cache = new Map();

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/geo+json' } });
  if (!res.ok) {
    if (res.status === 404) throw new Error('The National Weather Service has no forecast for this spot (outside the US?)');
    throw new Error(`NWS ${res.status}`);
  }
  return res.json();
}

/** Hours from an ISO 8601 duration like PT6H or P1DT3H. */
function hoursOf(dur) {
  const m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  return m ? (+(m[1] || 0)) * 24 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60 : 1;
}

/** Spread a grid series over hourly slots. Amounts are divided across their interval. */
function hourly(series, t0, n, amount = false) {
  const out = new Array(n).fill(null);
  for (const v of series?.values || []) {
    const [start, dur] = v.validTime.split('/');
    const s = Date.parse(start) / 1000;
    const h = Math.max(1, Math.round(hoursOf(dur)));
    for (let k = 0; k < h; k++) {
      const i = Math.round((s + k * 3600 - t0) / 3600);
      if (i >= 0 && i < n && v.value != null) out[i] = amount ? v.value / h : v.value;
    }
  }
  return out;
}

export async function loadForecast(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60e3) return hit.data;
  const pt = (await getJSON(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).properties;
  const [grid, periods, alerts] = await Promise.all([
    getJSON(pt.forecastGridData),
    getJSON(pt.forecast),
    getJSON(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`).catch(() => ({ features: [] })),
  ]);
  const g = grid.properties;
  const n = 7 * 24;
  const t0 = Math.floor(Date.now() / 3600e3) * 3600;
  const data = {
    place: [pt.relativeLocation?.properties?.city, pt.relativeLocation?.properties?.state].filter(Boolean).join(', '),
    office: pt.cwa,
    t0,
    n,
    temp: hourly(g.temperature, t0, n),
    feels: hourly(g.apparentTemperature, t0, n),
    pop: hourly(g.probabilityOfPrecipitation, t0, n),
    qpf: hourly(g.quantitativePrecipitation, t0, n, true),
    snow: hourly(g.snowfallAmount, t0, n, true),
    wind: hourly(g.windSpeed, t0, n),
    gust: hourly(g.windGust, t0, n),
    dir: hourly(g.windDirection, t0, n),
    sky: hourly(g.skyCover, t0, n),
    periods: periods.properties.periods || [],
    alerts: (alerts.features || []).map((f) => f.properties),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------- formatting

export const tempOf = (c, unit) => (c == null ? null : unit === 'C' ? c : c * 9 / 5 + 32);

export function emoji(text = '', night = false) {
  const t = text.toLowerCase();
  if (/thunder|t-storm/.test(t)) return '⛈️';
  if (/snow|flurr|blizzard/.test(t)) return /rain|sleet|mix/.test(t) ? '🌨️' : '❄️';
  if (/sleet|freezing|ice/.test(t)) return '🧊';
  if (/rain|shower|drizzle/.test(t)) return /chance|slight|isolated|scattered/.test(t) ? '🌦️' : '🌧️';
  if (/fog|haze|smoke/.test(t)) return '🌫️';
  if (/wind|breezy|blustery/.test(t)) return '💨';
  if (/cloudy|overcast/.test(t) && !/partly|mostly sunny|mostly clear/.test(t)) return '☁️';
  if (/partly|mostly/.test(t)) return night ? '☁️' : '⛅';
  return night ? '🌙' : '☀️';
}

const ALERT_COLOR = (e) => (/tornado/i.test(e) ? '#ff2d55' : /severe thunderstorm/i.test(e) ? '#ffb020' : /flood/i.test(e) ? '#2ee66b'
  : /winter|snow|ice|blizzard|freez|frost|cold|chill/i.test(e) ? '#7fd3ff' : /heat/i.test(e) ? '#ff6b3d' : /wind|gale/i.test(e) ? '#d9b38c'
    : /fire|red flag/i.test(e) ? '#ff453a' : '#bf9fff');

/** One-line summary for the "here" card. */
export function summaryLine(f, units) {
  const today = f.periods[0];
  const amount = (arr, h) => arr.slice(0, h).reduce((a, b) => a + (b || 0), 0);
  const rain24 = amount(f.qpf, 24), snow24 = amount(f.snow, 24);
  const temp = (v) => `${Math.round(tempOf(v, units.temp))}°`;
  const now = f.temp.find((x) => x != null);
  let s = `${emoji(today?.shortForecast, today && !today.isDaytime)} ${now != null ? temp(now) + ' · ' : ''}${today ? `${today.shortForecast}` : ''}`;
  if (snow24 >= 2.5) s += ` · ${units.rain === 'mm' ? `${U.fmt(snow24 / 10, 1)} cm` : `${U.fmt(snow24 / 25.4, 1)} in`} of snow in 24 h`;
  else if (rain24 >= 1) s += ` · ${U.fmtU(U.rain(rain24 / 25.4, units.rain), units.rain === 'mm' ? 0 : 2)} of rain in 24 h`;
  return s;
}

// ---------------------------------------------------------------- charts

function hourLabel(t, utc) {
  const d = new Date(t * 1000);
  return utc ? `${String(d.getUTCHours()).padStart(2, '0')}Z` : d.toLocaleTimeString(undefined, { hour: 'numeric' }).replace(':00', '').replace(' ', '');
}

function dayLabel(t, utc) {
  const d = new Date(t * 1000);
  return d.toLocaleDateString(undefined, { weekday: 'short', timeZone: utc ? 'UTC' : undefined });
}

/** Shared x axis, alert bands and day lines for one chart. */
function frame(f, hours, W, H, L, R, T, B, utc) {
  const x = (i) => L + (i / hours) * (W - L - R);
  const parts = [];
  for (const a of f.alerts) {
    const s = Date.parse(a.onset || a.effective) / 1000, e = Date.parse(a.ends || a.expires) / 1000;
    const i0 = Math.max(0, (s - f.t0) / 3600), i1 = Math.min(hours, (e - f.t0) / 3600);
    if (i1 <= 0 || i0 >= hours) continue;
    parts.push(`<rect x="${x(i0)}" y="${T}" width="${Math.max(2, x(i1) - x(i0))}" height="${H - T - B}" fill="${ALERT_COLOR(a.event)}" opacity="0.13"/>`);
  }
  for (let i = 0; i <= hours; i++) {
    const t = f.t0 + i * 3600;
    const d = new Date(t * 1000);
    const hr = utc ? d.getUTCHours() : d.getHours();
    if (hr === 0 && i > 0) parts.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" class="day"/><text x="${x(i) + 3}" y="${T + 9}" class="dl">${dayLabel(t, utc)}</text>`);
    if (i % 6 === 0 && i < hours) parts.push(`<text x="${x(i)}" y="${H - 4}" class="hl" text-anchor="${i === 0 ? 'start' : 'middle'}">${i === 0 ? 'Now' : hourLabel(t, utc)}</text>`);
  }
  return { x, parts };
}

function linePath(vals, x, y) {
  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i + 0.5).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function charts(f, units, utc, hours = 48) {
  const W = 340, L = 30, R = 6;
  const out = [];
  // Temperature
  {
    const H = 120, T = 6, B = 16;
    const temps = f.temp.slice(0, hours).map((c) => tempOf(c, units.temp));
    const feels = f.feels.slice(0, hours).map((c) => tempOf(c, units.temp));
    const all = temps.concat(feels).filter((v) => v != null);
    if (all.length) {
      let lo = Math.floor(Math.min(...all) / 5) * 5, hi = Math.ceil(Math.max(...all) / 5) * 5;
      if (hi - lo < 10) hi = lo + 10;
      const { x, parts } = frame(f, hours, W, H, L, R, T, B, utc);
      const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
      const grid = [];
      for (let v = lo; v <= hi; v += (hi - lo) > 30 ? 10 : 5) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" class="yl">${v}°</text>`);
      const fill = `${linePath(temps, x, y)}L${x(hours - 0.5)},${H - B}L${x(0.5)},${H - B}Z`;
      const tmax = Math.max(...temps.filter((v) => v != null)), tmin = Math.min(...temps.filter((v) => v != null));
      const iMax = temps.indexOf(tmax), iMin = temps.indexOf(tmin);
      out.push(`<div class="fc-chart"><div class="fc-h"><b>Temperature</b><span><i class="k-temp"></i>Air <i class="k-feel"></i>Feels like</span></div>
        <svg viewBox="0 0 ${W} ${H}" class="fcsvg" role="img" aria-label="Temperature for the next ${hours} hours">
          <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff9f0a" stop-opacity="0.35"/><stop offset="1" stop-color="#ff9f0a" stop-opacity="0"/></linearGradient></defs>
          ${grid.join('')}${parts.join('')}
          <path d="${fill}" fill="url(#tg)"/>
          <path d="${linePath(feels, x, y)}" class="feel"/>
          <path d="${linePath(temps, x, y)}" class="temp"/>
          <text x="${x(iMax + 0.5)}" y="${y(tmax) - 5}" text-anchor="middle" class="ann">${Math.round(tmax)}°</text>
          <text x="${x(iMin + 0.5)}" y="${y(tmin) + 12}" text-anchor="middle" class="ann">${Math.round(tmin)}°</text>
        </svg></div>`);
    }
  }
  // Precipitation chance and amount
  {
    const H = 110, T = 6, B = 16;
    const { x, parts } = frame(f, hours, W, H, L, R, T, B, utc);
    const y = (p) => T + (1 - p / 100) * (H - T - B);
    const bw = (W - L - R) / hours;
    const qpf = f.qpf.slice(0, hours), snow = f.snow.slice(0, hours);
    const maxAmt = Math.max(1, ...qpf.map((v) => v || 0), ...snow.map((v) => (v || 0) / 10));
    const ya = (v) => (H - B) - (v / maxAmt) * (H - T - B) * 0.9;
    const bars = [];
    f.pop.slice(0, hours).forEach((p, i) => { if (p) bars.push(`<rect x="${x(i)}" y="${y(p)}" width="${bw}" height="${H - B - y(p)}" class="pop"/>`); });
    qpf.forEach((v, i) => { if (v > 0.05) bars.push(`<rect x="${x(i) + bw * 0.15}" y="${ya(v)}" width="${bw * 0.7}" height="${H - B - ya(v)}" class="qpf"/>`); });
    snow.forEach((v, i) => { if (v > 0.5) bars.push(`<rect x="${x(i) + bw * 0.15}" y="${ya(v / 10)}" width="${bw * 0.7}" height="${H - B - ya(v / 10)}" class="snw"/>`); });
    const grid = [0, 50, 100].map((p) => `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" class="g"/><text x="${L - 4}" y="${y(p) + 3}" text-anchor="end" class="yl">${p}%</text>`);
    const tot = qpf.reduce((a, b) => a + (b || 0), 0), stot = snow.reduce((a, b) => a + (b || 0), 0);
    const rainTxt = tot >= 0.25 ? `${U.fmtU(U.rain(tot / 25.4, units.rain), units.rain === 'mm' ? 0 : 2)} rain` : 'little or no rain';
    const snowTxt = stot >= 2.5 ? ` · ${units.rain === 'mm' ? `${U.fmt(stot / 10, 1)} cm` : `${U.fmt(stot / 25.4, 1)} in`} snow` : '';
    out.push(`<div class="fc-chart"><div class="fc-h"><b>Rain &amp; snow</b><span><i class="k-pop"></i>Chance <i class="k-qpf"></i>Amount${stot >= 2.5 ? ' <i class="k-snw"></i>Snow' : ''}</span></div>
      <svg viewBox="0 0 ${W} ${H}" class="fcsvg" role="img" aria-label="Precipitation for the next ${hours} hours">${grid.join('')}${parts.join('')}${bars.join('')}</svg>
      <p class="fc-sum">Next ${hours} h: ${rainTxt}${snowTxt}</p></div>`);
  }
  // Wind
  {
    const H = 100, T = 6, B = 16;
    const conv = (k) => (k == null ? null : U.speed(k / 3.6, units.speed).v);
    const w = f.wind.slice(0, hours).map(conv), gst = f.gust.slice(0, hours).map(conv);
    const all = w.concat(gst).filter((v) => v != null);
    if (all.length) {
      const hi = Math.max(10, Math.ceil(Math.max(...all) / 10) * 10);
      const { x, parts } = frame(f, hours, W, H, L, R, T, B, utc);
      const y = (v) => T + (1 - v / hi) * (H - T - B);
      const grid = [0, hi / 2, hi].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" class="yl">${Math.round(v)}</text>`);
      const arrows = [];
      for (let i = 1; i < hours; i += 3) {
        const d = f.dir[i];
        if (d == null || w[i] == null) continue;
        // Arrow points where the wind blows toward.
        arrows.push(`<g transform="translate(${x(i + 0.5)},${y(w[i]) - 9}) rotate(${(d + 180) % 360})"><path d="M0,-4 L2.6,3 L0,1.6 L-2.6,3 Z" class="arw"/></g>`);
      }
      const unit = U.speed(1, units.speed).unit;
      out.push(`<div class="fc-chart"><div class="fc-h"><b>Wind · ${unit}</b><span><i class="k-wind"></i>Speed <i class="k-gust"></i>Gusts</span></div>
        <svg viewBox="0 0 ${W} ${H}" class="fcsvg" role="img" aria-label="Wind for the next ${hours} hours">${grid.join('')}${parts.join('')}
          <path d="${linePath(gst, x, y)}" class="gust"/><path d="${linePath(w, x, y)}" class="wind"/>${arrows.join('')}</svg></div>`);
    }
  }
  return out.join('');
}

/** 7-day list with high/low range bars, Apple-Weather style. */
export function days(f, units) {
  const rows = [];
  const ps = f.periods;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.isDaytime && i !== 0) continue;
    const night = p.isDaytime ? ps[i + 1] : p;
    const day = p.isDaytime ? p : null;
    const hiF = day ? day.temperature : null, loF = night && !night.isDaytime ? night.temperature : null;
    rows.push({ name: day ? day.name : p.name, text: (day || p).shortForecast, night: !day, hi: hiF, lo: loF, pop: Math.max(day?.probabilityOfPrecipitation?.value || 0, night?.probabilityOfPrecipitation?.value || 0), detail: (day || p).detailedForecast });
  }
  const conv = (fv) => (fv == null ? null : units.temp === 'C' ? (fv - 32) * 5 / 9 : fv);
  const vals = rows.flatMap((r) => [conv(r.hi), conv(r.lo)]).filter((v) => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pos = (v) => ((v - lo) / Math.max(1, hi - lo)) * 100;
  return `<div class="days">${rows.slice(0, 7).map((r) => {
    const h = conv(r.hi), l = conv(r.lo);
    const a = l != null ? pos(l) : pos(h), b = h != null ? pos(h) : pos(l);
    return `<details class="day-row"><summary><span class="dn">${r.name.replace(' Night', '').replace('This Afternoon', 'Today').replace('Tonight', 'Tonight')}</span>
      <span class="de" title="${r.text}">${emoji(r.text, r.night)}</span>
      <span class="dp">${r.pop >= 20 ? `${r.pop}%` : ''}</span>
      <span class="dl">${l != null ? `${Math.round(l)}°` : ''}</span>
      <span class="dr"><i style="left:${a}%;width:${Math.max(4, b - a)}%"></i></span>
      <span class="dh">${h != null ? `${Math.round(h)}°` : ''}</span></summary>
      <p>${r.detail || r.text}</p></details>`;
  }).join('')}</div>`;
}

export function alertChips(f, utc) {
  if (!f.alerts.length) return '';
  return `<div class="fc-alerts">${f.alerts.map((a) => {
    const s = Date.parse(a.onset || a.effective) / 1000, e = Date.parse(a.ends || a.expires) / 1000;
    return `<details class="fc-alert" style="--c:${ALERT_COLOR(a.event)}"><summary><b>${a.event}</b><span>${U.dateTime(s, utc)} – ${U.dateTime(e, utc)}</span></summary><pre class="bulletin">${(a.description || '').replace(/[<>&]/g, '')}</pre></details>`;
  }).join('')}</div>`;
}
