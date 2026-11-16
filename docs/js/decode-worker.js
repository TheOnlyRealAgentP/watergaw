// Fetches and decodes radar files off the main thread.
import { loadCore } from './core.js';

const ready = loadCore();

self.onmessage = async (e) => {
  const { id, url, nowcast, mrms, l2load, l2xsect, l2cut } = e.data;
  try {
    const core = await ready;
    if (l2load) {
      const res = await fetch(l2load);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const summary = core.level2Load(new Uint8Array(await res.arrayBuffer()));
      self.postMessage({ id, result: summary });
      return;
    }
    if (l2xsect) {
      const { moment, a, b, nx, nz, top } = l2xsect;
      const out = core.level2Xsect(moment, a, b, nx, nz, top);
      self.postMessage({ id, result: out }, [out.values.buffer]);
      return;
    }
    if (l2cut != null) {
      const s = core.level2Cut(l2cut);
      self.postMessage({ id, result: s }, [s.codes.buffer, s.lut.buffer, s.flags.buffer]);
      return;
    }
    if (mrms) {
      const res = await fetch(mrms.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = res.body.pipeThrough(new DecompressionStream('gzip'));
      const bytes = new Uint8Array(await new Response(raw).arrayBuffer());
      const out = core.grib2Crop(bytes, mrms.box, mrms.width, mrms.height);
      self.postMessage({ id, mrms: out }, [out.values.buffer]);
      return;
    }
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
