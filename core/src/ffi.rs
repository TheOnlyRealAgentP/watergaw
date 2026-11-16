//! C ABI used by the browser (WebAssembly) build.
//!
//! No wasm-bindgen: the page loads one `.wasm` file and talks to it through
//! these few functions. Results come back as a [`Blob`]: up to four byte
//! buffers (JSON metadata plus raw arrays) that JavaScript copies out and then
//! frees with `of_blob_free`.

use crate::{geo, level3};
use std::fmt::Write;

#[repr(C)]
pub struct Blob {
    /// (pointer, byte length) for: metadata JSON, array A, array B, array C.
    pub parts: [usize; 8],
}

#[repr(C)]
struct Owned {
    header: Blob,
    bufs: [Vec<u8>; 4],
}

fn blob(bufs: [Vec<u8>; 4]) -> *mut Blob {
    let mut o = Box::new(Owned { header: Blob { parts: [0; 8] }, bufs });
    for i in 0..4 {
        o.header.parts[i * 2] = o.bufs[i].as_ptr() as usize;
        o.header.parts[i * 2 + 1] = o.bufs[i].len();
    }
    Box::into_raw(o) as *mut Blob
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn u32_bytes(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn esc(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            c if (c as u32) < 0x20 => format!("\\u{:04x}", c as u32).chars().collect(),
            c => vec![c],
        })
        .collect()
}

fn num(v: f64) -> String {
    if v.is_finite() { format!("{v}") } else { "null".into() }
}

/// JSON description of a decoded Level III sweep.
pub fn sweep_json(s: &level3::Sweep) -> String {
    let h = &s.header;
    let mut j = String::with_capacity(512);
    let _ = write!(
        j,
        "{{\"code\":{},\"name\":\"{}\",\"units\":\"{}\",\"categorical\":{},\"site\":\"{}\",\
\"lat\":{},\"lon\":{},\"height_ft\":{},\"vcp\":{},\"op_mode\":{},\"vol_time\":{},\"scan_time\":{},\
\"gen_time\":{},\"elevation\":{},\"elevation_num\":{},\"supplemental\":{},\"gate_km\":{},\
\"first_gate_km\":{},\"gates\":{},\"rows\":{},\"az0\":{},\"delta\":{},\"radials\":{},\"extra\":{{",
        h.product_code,
        esc(s.name),
        esc(s.units),
        s.kind == level3::Kind::Categorical,
        esc(&h.awips_site),
        num(h.lat),
        num(h.lon),
        num(h.height_ft),
        h.vcp,
        h.op_mode,
        num(h.vol_time),
        num(s.scan_time),
        num(h.gen_time),
        num(s.elevation_deg),
        h.elevation_num,
        s.supplemental,
        num(s.gate_km),
        num(s.first_gate_km),
        s.gates,
        s.rows,
        num(s.az0),
        num(s.delta),
        s.raw.len(),
    );
    for (i, (k, v)) in s.extra.iter().enumerate() {
        let _ = write!(j, "{}\"{}\":{}", if i > 0 { "," } else { "" }, k, num(*v));
    }
    j.push_str("}}");
    j
}

#[unsafe(no_mangle)]
pub extern "C" fn of_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `of_alloc(len)` with the same `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn of_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) }
}

/// # Safety
/// `ptr` must come from one of the functions returning `*mut Blob`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn of_blob_free(ptr: *mut Blob) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr as *mut Owned)) }
    }
}

/// Decode a Level III file. Parts: JSON metadata (or `{"error":...}`), codes
/// (rows x gates bytes), lookup values (256 f32), lookup flags (256 bytes).
///
/// # Safety
/// `ptr..ptr+len` must be readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn of_decode_level3(ptr: *const u8, len: usize) -> *mut Blob {
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    match level3::decode(data) {
        Ok(s) => blob([
            sweep_json(&s).into_bytes(),
            s.codes,
            f32_bytes(&s.lut_value),
            s.lut_flag.to_vec(),
        ]),
        Err(e) => blob([format!("{{\"error\":\"{}\"}}", esc(&e.to_string())).into_bytes(), vec![], vec![], vec![]]),
    }
}

/// Sweep mesh. Parts: empty, vertices (f32 x4 each), indices (u32).
#[unsafe(no_mangle)]
pub extern "C" fn of_sweep_mesh(lat: f64, lon: f64, elev_deg: f64, max_range_km: f64, n_az: u32, n_rings: u32) -> *mut Blob {
    let (v, i) = geo::sweep_mesh(lat, lon, elev_deg, max_range_km, n_az.max(4) as usize, n_rings.max(1) as usize);
    blob([vec![], f32_bytes(&v), u32_bytes(&i), vec![]])
}

static mut OUT: [f64; 8] = [0.0; 8];

/// Where a map point sits in a sweep: writes [azimuth°, ground km, slant km,
/// beam height km above the radar] and returns a pointer to them.
#[unsafe(no_mangle)]
pub extern "C" fn of_polar(site_lat: f64, site_lon: f64, elev_deg: f64, lat: f64, lon: f64) -> *const f64 {
    let (az, ground) = geo::inverse(site_lat, site_lon, lat, lon);
    let slant = geo::slant_range_km(ground, elev_deg);
    let h = geo::beam_height_km(slant, elev_deg);
    let out = &raw mut OUT;
    unsafe {
        (*out)[0] = az;
        (*out)[1] = ground;
        (*out)[2] = slant;
        (*out)[3] = h;
        (*out).as_ptr()
    }
}

/// Destination point; writes [lat, lon].
#[unsafe(no_mangle)]
pub extern "C" fn of_destination(lat: f64, lon: f64, az_deg: f64, dist_km: f64) -> *const f64 {
    let (la, lo) = geo::destination(lat, lon, az_deg, dist_km);
    let out = &raw mut OUT;
    unsafe {
        (*out)[0] = la;
        (*out)[1] = lo;
        (*out).as_ptr()
    }
}

/// Beam height (km above the radar) at a slant range.
#[unsafe(no_mangle)]
pub extern "C" fn of_beam_height(slant_km: f64, elev_deg: f64) -> f64 {
    geo::beam_height_km(slant_km, elev_deg)
}

/// Rain nowcast. `params` holds, for the older then the newer sweep,
/// [rows, gates, gate_km, first_km, az0, delta, elevation], then the seconds
/// between them (15 numbers). `steps` are lead times in seconds. When no rain
/// can be tracked, the fallback motion (km/s east, north) is used instead.
/// Parts: JSON summary, future codes for every step back to back, motion field
/// (f32 u, v per block, km/s).
///
/// # Safety
/// All pointers must be valid for the lengths given; LUTs hold 256 f32 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn of_nowcast(
    params: *const f64,
    prev: *const u8,
    prev_len: usize,
    prev_lut: *const f32,
    cur: *const u8,
    cur_len: usize,
    cur_lut: *const f32,
    steps: *const f64,
    nsteps: usize,
    fallback_u: f64,
    fallback_v: f64,
) -> *mut Blob {
    use crate::nowcast::{advect, estimate_motion, to_grid, Motion, Polar};
    let p = unsafe { std::slice::from_raw_parts(params, 15) };
    let mk = |codes: &'static [u8], lut: &'static [f32], o: usize| Polar {
        codes,
        lut,
        rows: p[o] as usize,
        gates: p[o + 1] as usize,
        gate_km: p[o + 2],
        first_km: p[o + 3],
        az0: p[o + 4],
        delta: p[o + 5],
        elev: p[o + 6],
    };
    let (a, la, b, lb, st) = unsafe {
        (
            std::slice::from_raw_parts(prev, prev_len),
            std::slice::from_raw_parts(prev_lut, 256),
            std::slice::from_raw_parts(cur, cur_len),
            std::slice::from_raw_parts(cur_lut, 256),
            std::slice::from_raw_parts(steps, nsteps),
        )
    };
    let older = mk(a, la, 0);
    let newer = mk(b, lb, 7);
    if older.rows * older.gates != a.len() || newer.rows * newer.gates != b.len() {
        return blob([b"{\"error\":\"sweep size mismatch\"}".to_vec(), vec![], vec![], vec![]]);
    }
    let dt = p[14];
    let g0 = to_grid(&older, 2.0, 18.0);
    let g1 = to_grid(&newer, 2.0, 18.0);
    let mut m = estimate_motion(&g0, &g1, dt);
    let tracked = m.valid;
    if tracked == 0 && (fallback_u != 0.0 || fallback_v != 0.0) {
        m = Motion::uniform(g1.half, fallback_u as f32, fallback_v as f32);
    }
    let mut codes = Vec::with_capacity(b.len() * nsteps);
    for &tau in st {
        codes.extend(advect(&newer, &m, tau));
    }
    let (mu, mv) = m.mean();
    let field: Vec<f32> = m.u.iter().zip(&m.v).flat_map(|(u, v)| [*u, *v]).collect();
    let meta = format!(
        "{{\"tracked_blocks\":{},\"blocks\":{},\"mean_u\":{},\"mean_v\":{},\"speed_kmh\":{},\"dir_to\":{}}}",
        tracked,
        m.nb,
        num(mu),
        num(mv),
        num((mu * mu + mv * mv).sqrt() * 3600.0),
        num(mu.atan2(mv).to_degrees().rem_euclid(360.0)),
    );
    blob([meta.into_bytes(), codes, f32_bytes(&field), vec![]])
}

/// Crop a PNG-packed GRIB2 field (MRMS) to a box, max-pooled onto an
/// out_w x out_h grid with rows evenly spaced in Web Mercator (north first).
/// Parts: JSON (time, product ids, grid), f32 values (NaN = nothing).
///
/// # Safety
/// `ptr..ptr+len` must be readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn of_grib2_crop(ptr: *const u8, len: usize, lat_n: f64, lat_s: f64, lon_w: f64, lon_e: f64, out_w: u32, out_h: u32) -> *mut Blob {
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    let result = crate::grib2::parse(data).and_then(|f| {
        let v = crate::grib2::crop_mercator(&f, lat_n, lat_s, lon_w, lon_e, out_w as usize, out_h as usize)?;
        Ok((f, v))
    });
    match result {
        Ok((f, v)) => {
            let meta = format!(
                "{{\"time\":{},\"category\":{},\"number\":{},\"ni\":{},\"nj\":{},\"la1\":{},\"lo1\":{},\"di\":{}}}",
                num(f.time), f.category, f.number, f.ni, f.nj, num(f.la1), num(f.lo1), num(f.di)
            );
            blob([meta.into_bytes(), f32_bytes(&v), vec![], vec![]])
        }
        Err(e) => blob([format!("{{\"error\":\"{}\"}}", esc(&e.to_string())).into_bytes(), vec![], vec![], vec![]]),
    }
}
