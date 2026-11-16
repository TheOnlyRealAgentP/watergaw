// Fetches and decodes radar files off the main thread.
import { loadCore } from './core.js';

const ready = loadCore();

self.onmessage = async (e) => {
  const { id, url, nowcast } = e.data;
  try {
    const core = await ready;
    if (nowcast) {
      const { older, newer, dt, leads, fallback } = nowcast;
      const out = core.nowcast(older, newer, dt, leads, fallback);
      self.postMessage({ id, nowcast: out }, out.frames.map((f) => f.buffer));
      return;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const s = core.decodeLevel3(bytes);
    s.bytes = bytes.length;
    self.postMessage({ id, sweep: s }, [s.codes.buffer, s.lut.buffer, s.flags.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
