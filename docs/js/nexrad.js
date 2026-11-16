// NEXRAD Level III data: product catalog, S3 listings, decode pool and cache.
//
// Files come straight from the NOAA Open Data bucket on AWS
// (unidata-nexrad-level3), which allows browser requests. Keys look like
// TLX_N0B_2026_11_15_23_45_11 (radar, product, volume start time UTC).

export const L3_BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';

// Level III elevation slots, lowest first. Actual angles depend on the VCP and
// are read from each file.
export const TILTS = ['N0', 'NA', 'N1', 'NB', 'N2', 'N3'];
export const TILT_HINT = ['0.5°', '0.9°', '1.3°', '1.8°', '2.4°', '3.1°'];

export const PRODUCTS = [
  { id: 'REF', short: 'REF', name: 'Reflectivity', codes: ['N0B', 'NAB', 'N1B', 'NBB', 'N2B', 'N3B'], palette: 'REF', kind: 'ref',
    about: 'How much energy echoes return. Higher dBZ means heavier rain or hail.' },
  { id: 'VEL', short: 'VEL', name: 'Velocity', codes: ['N0G', 'NAG', 'N1G', 'NBU', 'N2U', 'N3U'], palette: 'VEL', kind: 'vel',
    about: 'Wind toward (green) or away from (red) the radar. Tight green–red pairs mark rotation.' },
  { id: 'SRV', short: 'SRV', name: 'Storm-Relative Velocity', codes: ['N0G', 'NAG', 'N1G', 'NBU', 'N2U', 'N3U'], palette: 'VEL', kind: 'vel', srv: true,
    about: 'Velocity with the storms’ own motion removed, so rotation stands out. Super-resolution, computed on your device.' },
  { id: 'CC', short: 'CC', name: 'Correlation Coefficient', codes: ['N0C', 'NAC', 'N1C', 'NBC', 'N2C', 'N3C'], palette: 'CC', kind: 'cc',
    about: 'How alike the targets are. Rain is near 1; a low-CC hole inside rotation can be tornado debris.' },
  { id: 'ZDR', short: 'ZDR', name: 'Differential Reflectivity', codes: ['N0X', 'NAX', 'N1X', 'NBX', 'N2X', 'N3X'], palette: 'ZDR', kind: 'zdr',
    about: 'Shape of the targets. Big flattened raindrops are high; tumbling hail is near zero.' },
  { id: 'KDP', short: 'KDP', name: 'Specific Differential Phase', codes: ['N0K', 'NAK', 'N1K', 'NBK', 'N2K', 'N3K'], palette: 'KDP', kind: 'kdp',
    about: 'Tracks liquid water content. High KDP means very heavy rain.' },
  { id: 'HC', short: 'HC', name: 'Hydrometeor Classification', codes: ['N0H', 'NAH', 'N1H', 'NBH', 'N2H', 'N3H'], palette: 'HC', kind: 'hc', categorical: true,
    about: 'The radar’s best guess at what it sees: rain, snow, hail, birds and bugs, or clutter.' },
  { id: 'VIL', short: 'VIL', name: 'Vertically Integrated Liquid', codes: ['DVL'], palette: 'VIL', kind: 'vil', volume: true,
    about: 'Water in the whole column above each point. Very high VIL often means large hail.' },
  { id: 'ET', short: 'ET', name: 'Echo Tops', codes: ['EET'], palette: 'ET', kind: 'et', volume: true,
    about: 'Height of the top of the storm (18 dBZ). Tall tops mean strong updrafts.' },
  { id: 'P1H', short: '1H', name: '1-Hour Rainfall', codes: ['DAA'], palette: 'PRECIP', kind: 'precip', volume: true,
    about: 'Dual-pol rainfall estimate for the last hour.' },
  { id: 'P3H', short: '3H', name: '3-Hour Rainfall', codes: ['DU3'], palette: 'PRECIP', kind: 'precip', volume: true,
    about: 'Dual-pol rainfall estimate for the last three hours (updated hourly).' },
  { id: 'P24', short: '24H', name: '24-Hour Rainfall', codes: ['DU6'], palette: 'PRECIP', kind: 'precip', volume: true,
    about: 'Dual-pol rainfall for the 24 hours ending 12Z (updated once a day).' },
  { id: 'PST', short: 'STP', name: 'Storm Total Rainfall', codes: ['DTA'], palette: 'PRECIP', kind: 'precip', volume: true,
    about: 'Dual-pol rainfall since the current rain event began.' },
];

export const PRODUCT = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));

export function productCode(productId, tilt) {
  const p = PRODUCT[productId];
  return p.codes[Math.min(tilt, p.codes.length - 1)];
}

export function keyTime(key) {
  const m = key.match(/_(\d{4})_(\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : NaN;
}

function stamp(t) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}_${p(d.getUTCMonth() + 1)}_${p(d.getUTCDate())}_${p(d.getUTCHours())}_${p(d.getUTCMinutes())}`;
}

async function listKeys(prefix, startAfter) {
  const keys = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) q.set('continuation-token', token);
    else q.set('start-after', startAfter);
    const res = await fetch(`${L3_BUCKET}/?${q}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Listing failed (HTTP ${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!t) break;
    token = t[1];
  }
  return keys;
}

/** Available frames of one product at one radar, newest last. */
export class Series {
  constructor(site3, code) {
    this.site = site3;
    this.code = code;
    this.prefix = `${site3}_${code}_`;
    this.keys = [];
    this.updated = 0;
    this.error = null;
  }

  get id() { return this.prefix; }

  /** Fetch new keys. Returns true when the list changed. */
  async refresh(want) {
    const now = Date.now() / 1000;
    let added;
    try {
      if (!this.keys.length) {
        // Recent hours first; widen the window for slow clear-air scans or
        // once-a-day products like the 24-hour rainfall.
        let keys = [];
        for (const hours of [3, 12, 48]) {
          keys = await listKeys(this.prefix, this.prefix + stamp(now - hours * 3600));
          if (keys.length >= Math.min(want, 3)) break;
        }
        added = keys.length > 0;
        this.keys = keys.slice(-Math.max(want, 1) * 2);
      } else {
        const keys = await listKeys(this.prefix, this.keys[this.keys.length - 1]);
        added = keys.length > 0;
        this.keys = this.keys.concat(keys).slice(-Math.max(want, 1) * 2);
      }
      this.error = null;
    } catch (e) {
      this.error = e.message;
      return false;
    }
    this.updated = now;
    return added;
  }

  frames(n) {
    return this.keys.slice(-n).map((key) => ({ key, time: keyTime(key) }));
  }
}

/** Worker pool that decodes files, with an LRU cache of decoded sweeps. */
export class SweepStore {
  constructor() {
    const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = Array.from({ length: n }, () => new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' }));
    this.busy = new Array(n).fill(0);
    this.pending = new Map();
    this.nextId = 1;
    this.cache = new Map(); // key -> Promise<sweep>
    this.maxEntries = 160;
    this.maxBytes = 150e6; // decoded codes; keeps 4 panels x 30 frames of super-res on phones
    this.bytes = 0;
    this.workers.forEach((w, i) => {
      w.onmessage = (e) => {
        const { id, sweep, error } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.busy[i]--;
        if (error) p.reject(new Error(error));
        else p.resolve(sweep);
      };
    });
  }

  decode(url) {
    let best = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[best]) best = i;
    const id = this.nextId++;
    this.busy[best]++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.workers[best].postMessage({ id, url });
    });
  }

  get(key) {
    let p = this.cache.get(key);
    if (p) {
      this.cache.delete(key); // move to most-recent
      this.cache.set(key, p);
      return p;
    }
    p = this.decode(`${L3_BUCKET}/${key}`).then((s) => {
      s.key = key;
      s.time = s.meta.scan_time;
      this.bytes += s.codes.length;
      this.trim();
      return s;
    });
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    return p;
  }

  peek(key) {
    return this.cache.get(key);
  }

  trim() {
    while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, p] = this.cache.entries().next().value;
      this.cache.delete(k);
      p.then((s) => { this.bytes -= s.codes.length; }, () => {});
    }
  }
}

/** Value under a point, from the CPU copy of a sweep. */
export function sampleSweep(s, az, slantKm) {
  const m = s.meta;
  const g = Math.floor((slantKm - m.first_gate_km) / m.gate_km);
  if (g < 0 || g >= m.gates) return { flag: 1 };
  const row = (((Math.floor((az - m.az0) / m.delta)) % m.rows) + m.rows) % m.rows;
  const c = s.codes[row * m.gates + g];
  return { flag: s.flags[c], value: s.lut[c] };
}
