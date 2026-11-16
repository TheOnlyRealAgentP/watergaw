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
  };
}
