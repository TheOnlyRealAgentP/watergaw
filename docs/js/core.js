// Loads the Rust core (wasm/watergaw_core.wasm) and wraps its C ABI.
// The same module runs on the main thread (meshes, inspector math) and in the
// decode workers (see decode-worker.js).

const WASM_URL = new URL('../wasm/watergaw_core.wasm', import.meta.url);

export async function loadCore() {
  let instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(WASM_URL), {}));
  } catch {
    // Some servers send the wrong MIME type; fall back to a plain fetch.
    const bytes = await (await fetch(WASM_URL)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
  }
  return wrap(instance.exports);
}

export function wrap(w) {
  const mem = () => w.memory.buffer;

  // Copy a blob's four parts out of WASM memory, then free it.
  function take(ptr) {
    const u = new Uint32Array(mem(), ptr, 8);
    const parts = [];
    for (let i = 0; i < 4; i++) parts.push(mem().slice(u[i * 2], u[i * 2] + u[i * 2 + 1]));
    w.of_blob_free(ptr);
    return parts;
  }

  return {
    decodeLevel3(bytes) {
      const p = w.of_alloc(bytes.length);
      new Uint8Array(mem(), p, bytes.length).set(bytes);
      const blob = w.of_decode_level3(p, bytes.length);
      w.of_free(p, bytes.length);
      const [meta, codes, lut, flags] = take(blob);
      const m = JSON.parse(new TextDecoder().decode(meta));
      if (m.error) throw new Error(m.error);
      return { meta: m, codes: new Uint8Array(codes), lut: new Float32Array(lut), flags: new Uint8Array(flags) };
    },
    sweepMesh(lat, lon, elev, maxKm, nAz, nRings) {
      const [, v, i] = take(w.of_sweep_mesh(lat, lon, elev, maxKm, nAz, nRings));
      return { vertices: new Float32Array(v), indices: new Uint32Array(i) };
    },
    /** Azimuth, ground range, slant range, beam height (km above radar). */
    polar(siteLat, siteLon, elev, lat, lon) {
      const p = w.of_polar(siteLat, siteLon, elev, lat, lon);
      const a = new Float64Array(mem(), p, 4);
      return { az: a[0], ground: a[1], slant: a[2], height: a[3] };
    },
    destination(lat, lon, az, km) {
      const p = w.of_destination(lat, lon, az, km);
      const a = new Float64Array(mem(), p, 2);
      return [a[1], a[0]];
    },
    beamHeight: (slant, elev) => w.of_beam_height(slant, elev),
    /** Crop a PNG-packed GRIB2 field to a box (rows evenly spaced in Web Mercator). */
    grib2Crop(bytes, box, width, height) {
      const p = w.of_alloc(bytes.length);
      new Uint8Array(mem(), p, bytes.length).set(bytes);
      const blob = w.of_grib2_crop(p, bytes.length, box.n, box.s, box.w, box.e, width, height);
      w.of_free(p, bytes.length);
      const [meta, values] = take(blob);
      const m = JSON.parse(new TextDecoder().decode(meta));
      if (m.error) throw new Error(m.error);
      return { meta: m, values: new Float32Array(values) };
    },
    /**
     * Rain nowcast from two sweeps of the same product (older, newer).
     * Returns { summary, frames: Uint8Array[] (one per lead time), field }.
     */
    nowcast(older, newer, dt, leadSeconds, fallback = [0, 0]) {
      const put = (bytes) => { const p = w.of_alloc(bytes.byteLength); new Uint8Array(mem(), p, bytes.byteLength).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)); return [p, bytes.byteLength]; };
      const geom = (m) => [m.rows, m.gates, m.gate_km, m.first_gate_km, m.az0, m.delta, m.elevation];
      const params = new Float64Array([...geom(older.meta), ...geom(newer.meta), dt]);
      const steps = new Float64Array(leadSeconds);
      const lutA = new Float32Array(older.lut.map((v, i) => (older.flags[i] === 0 ? v : NaN)));
      const lutB = new Float32Array(newer.lut.map((v, i) => (newer.flags[i] === 0 ? v : NaN)));
      const bufs = [put(params), put(older.codes), put(lutA), put(newer.codes), put(lutB), put(steps)];
      const [pp, [ap, al], la, [bp, bl], lb, sp] = [bufs[0][0], bufs[1], bufs[2][0], bufs[3], bufs[4][0], bufs[5][0]];
      const blob = w.of_nowcast(pp, ap, al, la, bp, bl, lb, sp, steps.length, fallback[0], fallback[1]);
      for (const [p, n] of bufs) w.of_free(p, n);
      const [meta, codes, field] = take(blob);
      const summary = JSON.parse(new TextDecoder().decode(meta));
      if (summary.error) throw new Error(summary.error);
      const all = new Uint8Array(codes);
      const n = newer.codes.length;
      const frames = leadSeconds.map((_, i) => all.slice(i * n, (i + 1) * n));
      return { summary, frames, field: new Float32Array(field) };
    },
  };
}
