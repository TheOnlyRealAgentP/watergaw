// Unit conversion and number formatting.

export const UNIT_OPTIONS = {
  speed: [['kt', 'knots'], ['mph', 'mph'], ['ms', 'm/s'], ['kmh', 'km/h']],
  distance: [['mi', 'miles'], ['km', 'kilometres'], ['nm', 'nautical miles']],
  height: [['ft', 'feet'], ['m', 'metres']],
  rain: [['in', 'inches'], ['mm', 'millimetres']],
  temp: [['F', '°F'], ['C', '°C']],
};

export const DEFAULT_UNITS = { speed: 'kt', distance: 'mi', height: 'ft', rain: 'in', temp: 'F' };

const SPEED = { kt: [1.943844, 'kt'], mph: [2.236936, 'mph'], ms: [1, 'm/s'], kmh: [3.6, 'km/h'] };
const DIST = { mi: [0.621371, 'mi'], km: [1, 'km'], nm: [0.539957, 'nm'] };

export const speed = (ms, u) => ({ v: ms * SPEED[u][0], unit: SPEED[u][1] });
export const distance = (km, u) => ({ v: km * DIST[u][0], unit: DIST[u][1] });
export const height = (km, u) => (u === 'ft' ? { v: km * 3280.84, unit: 'ft' } : { v: km * 1000, unit: 'm' });
export const rain = (inch, u) => (u === 'mm' ? { v: inch * 25.4, unit: 'mm' } : { v: inch, unit: 'in' });
export const knotsTo = (kt, u) => speed(kt / 1.943844, u);

export function fmt(v, digits = 0) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtU(o, digits = 0) {
  return `${fmt(o.v, digits)} ${o.unit}`;
}

export function compass(deg) {
  const n = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return n[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function ago(sec) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - sec));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function clock(sec, utc) {
  const d = new Date(sec * 1000);
  if (utc) return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(sec, utc) {
  const d = new Date(sec * 1000);
  if (utc) return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
