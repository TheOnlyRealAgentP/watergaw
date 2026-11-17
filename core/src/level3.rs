//! NEXRAD Level III decoder (WSR-88D ICD 2620001).
//!
//! Handles the digital radial products a modern radar viewer needs: super-res
//! reflectivity and velocity, the dual-pol moments, hydrometeor class, digital
//! VIL, enhanced echo tops and the dual-pol rainfall accumulations. Each file
//! becomes a [`Sweep`]: one byte code per gate on a uniform azimuth grid plus a
//! 256-entry table that turns codes into physical values. Keeping the codes
//! as bytes is what lets the browser hold long animation loops on the GPU.

use crate::bytes::Reader;
use crate::Error;
use std::io::Read;

/// Meaning of a code in the lookup table.
pub const FLAG_VALID: u8 = 0;
pub const FLAG_NODATA: u8 = 1;
pub const FLAG_RANGE_FOLDED: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Continuous,
    Categorical,
}

/// One radial exactly as stored in the file.
#[derive(Debug, Clone)]
pub struct RawRadial {
    pub start_deg: f64,
    pub delta_deg: f64,
    pub codes: Vec<u8>,
}

/// Header fields from the message header and product description block.
#[derive(Debug, Clone, Default)]
pub struct Header {
    pub msg_code: i16,
    pub product_code: i16,
    pub lat: f64,
    pub lon: f64,
    pub height_ft: f64,
    pub op_mode: i16,
    pub vcp: i16,
    pub seq: i16,
    pub vol_num: i16,
    pub vol_time: f64,
    pub gen_time: f64,
    pub elevation_num: i16,
    pub thresholds: [i16; 16],
    /// Product dependent halfwords p1..p10 (ICD halfwords 27, 28, 30, 47-53).
    pub dep: [i16; 10],
    pub sym_off: i32,
    pub graph_off: i32,
    pub tab_off: i32,
    /// Radar ID from the AWIPS header (e.g. "HGX"), when present.
    pub awips_site: String,
}

#[derive(Debug, Clone)]
pub struct Sweep {
    pub header: Header,
    pub name: &'static str,
    pub units: &'static str,
    pub kind: Kind,
    pub elevation_deg: f64,
    /// Time the elevation scan started (volume start plus the product's delta time).
    pub scan_time: f64,
    pub supplemental: u8,
    pub gate_km: f64,
    pub first_gate_km: f64,
    pub gates: usize,
    /// Azimuth of the start of row 0, degrees.
    pub az0: f64,
    /// Width of every row, degrees.
    pub delta: f64,
    pub rows: usize,
    /// rows x gates codes, row-major.
    pub codes: Vec<u8>,
    pub lut_value: [f32; 256],
    pub lut_flag: [u8; 256],
    /// Product-specific numbers worth showing (max value, rainfall window, ...).
    pub extra: Vec<(&'static str, f64)>,
    /// The file's own radials, kept for verification.
    pub raw: Vec<RawRadial>,
    /// Text the radar attached (e.g. "No precipitation detected since ..." on null products).
    pub note: String,
}

struct Spec {
    name: &'static str,
    units: &'static str,
    gate_km: f64,
    /// Coverage used when a product arrives with no radial data (null product).
    range_km: f64,
    has_elevation: bool,
    has_delta_time: bool,
}

fn spec(code: i16) -> Option<Spec> {
    let s = |name, units, gate_km, has_elevation, has_delta_time| {
        let range_km = match code {
            94 | 134 | 153 => 460.0,
            135 => 345.0,
            99 | 154 | 155 | 159 | 161 | 163 | 165 => 300.0,
            _ => 230.0,
        };
        Some(Spec { name, units, gate_km, range_km, has_elevation, has_delta_time })
    };
    match code {
        // Lowest unblocked beam per bin: what rain gauges see, used for rainfall estimates.
        32 => s("Hybrid Scan Reflectivity", "dBZ", 1.0, false, false),
        94 => s("Base Reflectivity", "dBZ", 1.0, true, false),
        99 => s("Base Velocity", "m/s", 0.25, true, false),
        134 => s("Digital VIL", "kg/m²", 1.0, false, false),
        135 => s("Enhanced Echo Tops", "kft", 1.0, false, false),
        153 => s("Super-Res Reflectivity", "dBZ", 0.25, true, true),
        154 => s("Super-Res Velocity", "m/s", 0.25, true, true),
        155 => s("Super-Res Spectrum Width", "m/s", 0.25, true, true),
        159 => s("Differential Reflectivity", "dB", 0.25, true, true),
        161 => s("Correlation Coefficient", "", 0.25, true, true),
        163 => s("Specific Differential Phase", "°/km", 0.25, true, true),
        165 => s("Hydrometeor Classification", "", 0.25, true, true),
        170 => s("One-Hour Precipitation", "in", 0.25, false, false),
        172 => s("Storm Total Precipitation", "in", 0.25, false, false),
        173 => s("User-Selectable Precipitation", "in", 0.25, false, false),
        174 => s("One-Hour Difference Precipitation", "in", 0.25, false, false),
        175 => s("Storm Total Difference Precipitation", "in", 0.25, false, false),
        177 => s("Hybrid Hydrometeor Classification", "", 0.25, false, false),
        _ => None,
    }
}

/// Product codes whose data after the description block may be bzip2 compressed.
fn may_be_compressed(code: i16) -> bool {
    matches!(code, 32 | 94 | 99 | 113 | 134 | 135 | 138 | 149 | 152..=180 | 182 | 186 | 193 | 195 | 202)
}

/// Days-since-1970 (1 = 1 Jan 1970) plus seconds-after-midnight, to Unix seconds.
fn nexrad_time(date: i16, secs: i32) -> f64 {
    ((date as u16 as f64) - 1.0) * 86400.0 + secs as f64
}

/// The ICD's 16-bit float (sign, 5-bit exponent biased by 16, 10-bit fraction).
pub fn float16(v: i16) -> f64 {
    let v = v as u16;
    let frac = (v & 0x03ff) as f64;
    let exp = ((v >> 10) & 0x1f) as i32;
    let value = if exp != 0 {
        2f64.powi(exp - 16) * (1.0 + frac / 1024.0)
    } else {
        frac / 512.0
    };
    if v >> 15 != 0 { -value } else { value }
}

fn float32(hi: i16, lo: i16) -> f64 {
    f32::from_bits(((hi as u16 as u32) << 16) | lo as u16 as u32) as f64
}

/// Skip the WMO and AWIPS header lines if the file has them.
/// Returns the offset of the message header and the 3-letter radar ID.
fn strip_text_header(data: &[u8]) -> (usize, String) {
    let looks_text = data.len() > 30 && data[..4].iter().all(|b| b.is_ascii_uppercase());
    if !looks_text {
        return (0, String::new());
    }
    let mut ends = Vec::new();
    let mut i = 0;
    while i + 2 < data.len().min(80) {
        if &data[i..i + 3] == b"\r\r\n" {
            ends.push(i + 3);
            i += 3;
            if ends.len() == 2 {
                break;
            }
        } else {
            i += 1;
        }
    }
    if ends.len() < 2 {
        return (0, String::new());
    }
    let awips = String::from_utf8_lossy(&data[ends[0]..ends[1] - 3]).trim().to_string();
    let site = if awips.len() >= 6 { awips[awips.len() - 3..].to_string() } else { String::new() };
    (ends[1], site)
}

pub fn parse_header(data: &[u8]) -> Result<(Header, usize), Error> {
    let (start, site) = strip_text_header(data);
    let mut r = Reader::at(data, start)?;
    let mut h = Header { awips_site: site, ..Default::default() };
    h.msg_code = r.i16()?;
    let _msg_date = r.i16()?;
    let _msg_time = r.i32()?;
    let _msg_len = r.i32()?;
    let _src = r.i16()?;
    let _dst = r.i16()?;
    let _nblocks = r.i16()?;
    if r.i16()? != -1 {
        return Err(Error::Format("missing product description block divider"));
    }
    h.lat = r.i32()? as f64 * 0.001;
    h.lon = r.i32()? as f64 * 0.001;
    h.height_ft = r.i16()? as f64;
    h.product_code = r.i16()?;
    h.op_mode = r.i16()?;
    h.vcp = r.i16()?;
    h.seq = r.i16()?;
    h.vol_num = r.i16()?;
    let vol_date = r.i16()?;
    let vol_secs = r.i32()?;
    h.vol_time = nexrad_time(vol_date, vol_secs);
    let gen_date = r.i16()?;
    let gen_secs = r.i32()?;
    h.gen_time = nexrad_time(gen_date, gen_secs);
    h.dep[0] = r.i16()?;
    h.dep[1] = r.i16()?;
    h.elevation_num = r.i16()?;
    h.dep[2] = r.i16()?;
    for t in h.thresholds.iter_mut() {
        *t = r.i16()?;
    }
    for i in 3..10 {
        h.dep[i] = r.i16()?;
    }
    let _version = r.u8()?;
    let _spot_blank = r.u8()?;
    h.sym_off = r.i32()?;
    h.graph_off = r.i32()?;
    h.tab_off = r.i32()?;
    Ok((h, start))
}

fn build_lut(h: &Header) -> ([f32; 256], [u8; 256], Kind) {
    let mut value = [f32::NAN; 256];
    let mut flag = [FLAG_NODATA; 256];
    let t = &h.thresholds;
    let mut kind = Kind::Continuous;
    match h.product_code {
        // Digital reflectivity / velocity: min*10, increment*10, number of levels.
        32 | 94 | 99 | 153 | 154 => {
            let min = t[0] as f64 * 0.1;
            let inc = t[1] as f64 * 0.1;
            let levels = (t[2] as i32).clamp(0, 254) as usize;
            for i in 0..levels {
                value[i + 2] = (min + i as f64 * inc) as f32;
                flag[i + 2] = FLAG_VALID;
            }
            if matches!(h.product_code, 99 | 154) {
                flag[1] = FLAG_RANGE_FOLDED;
            }
        }
        155 => {
            let min = t[0] as f64 * 0.1;
            let inc = t[1] as f64 * 0.1;
            for i in 129..=167usize {
                value[i] = (min + (i - 129) as f64 * inc) as f32;
                flag[i] = FLAG_VALID;
            }
            flag[1] = FLAG_RANGE_FOLDED;
        }
        134 => {
            let lin_scale = float16(t[0]);
            let lin_offset = float16(t[1]);
            let log_start = (t[2] as i32).clamp(2, 255) as usize;
            let log_scale = float16(t[3]);
            let log_offset = float16(t[4]);
            for i in 2..255usize {
                let v = if i < log_start {
                    (i as f64 - lin_offset) / lin_scale
                } else {
                    ((i as f64 - log_offset) / log_scale).exp()
                };
                value[i] = v as f32;
                flag[i] = FLAG_VALID;
            }
        }
        135 => {
            let mask = t[0] as i32;
            let scale = t[1] as f64;
            let offset = t[2] as f64;
            for i in 2..256usize {
                value[i] = ((((i as i32) & mask) as f64 - offset) / scale) as f32;
                flag[i] = FLAG_VALID;
            }
        }
        159 | 161 | 163 | 170 | 172..=175 => {
            let scale = float32(t[0], t[1]);
            let offset = float32(t[2], t[3]);
            let max = (t[5] as u16 as usize).min(255);
            let leading = (t[6] as usize).min(256);
            let trailing = t[7] as usize;
            // Rainfall products are stored in hundredths of an inch.
            let unit = if h.product_code >= 170 { 0.01 } else { 1.0 };
            if leading > 1 {
                flag[1] = FLAG_RANGE_FOLDED;
            }
            if scale != 0.0 {
                let hi = max.saturating_sub(trailing);
                for i in leading..=hi {
                    value[i] = ((i as f64 - offset) / scale * unit) as f32;
                    flag[i] = FLAG_VALID;
                }
            }
        }
        165 | 177 => {
            kind = Kind::Categorical;
            // 10 BI, 20 GC, 30 IC, 40 DS, 50 WS, 60 RA, 70 HR, 80 BD, 90 GR,
            // 100 HA, 110 LH, 120 GH, 140 UK, 150 RF. Value = code / 10.
            for c in (10..=140).step_by(10) {
                if c == 130 {
                    continue;
                }
                value[c] = (c / 10) as f32;
                flag[c] = FLAG_VALID;
            }
            flag[150] = FLAG_RANGE_FOLDED;
        }
        _ => {}
    }
    (value, flag, kind)
}

fn extras(h: &Header) -> Vec<(&'static str, f64)> {
    let d = &h.dep;
    let date = |days: i16, mins: i16| nexrad_time(days, mins as i32 * 60);
    match h.product_code {
        94 | 153 => vec![("max", d[3] as f64)],
        99 | 154 => vec![("min", d[3] as f64), ("max", d[4] as f64)],
        134 => vec![("max", d[3] as f64)],
        135 => vec![("max", d[3] as f64)],
        159 => vec![("min", d[3] as f64 * 0.1), ("max", d[4] as f64 * 0.1)],
        161 => vec![("min", d[3] as f64 * 0.00333), ("max", d[4] as f64 * 0.00333)],
        163 => vec![("min", d[3] as f64 * 0.05), ("max", d[4] as f64 * 0.05)],
        170 => vec![("max", d[3] as f64 * 0.1), ("rain_end", date(d[4], d[5])), ("bias", d[6] as f64 * 0.01)],
        172 => vec![
            ("max", d[3] as f64 * 0.1),
            ("rain_begin", date(d[0], d[1])),
            ("rain_end", date(d[4], d[5])),
            ("bias", d[6] as f64 * 0.01),
        ],
        173 => vec![
            ("max", d[3] as f64 * 0.1),
            ("period_min", d[1] as f64),
            ("rain_end", date(d[4], d[0])),
        ],
        _ => vec![],
    }
}

fn read_digital_radials(r: &mut Reader) -> Result<(usize, usize, Vec<RawRadial>), Error> {
    let first_bin = r.u16()? as usize;
    let nbins = r.u16()? as usize;
    let _i = r.i16()?;
    let _j = r.i16()?;
    let _scale = r.i16()?;
    let nrad = r.u16()? as usize;
    let mut out = Vec::with_capacity(nrad);
    for _ in 0..nrad {
        let nbytes = r.u16()? as usize;
        let start = r.i16()? as f64 * 0.1;
        let delta = r.i16()? as f64 * 0.1;
        let bytes = r.take(nbytes)?;
        out.push(RawRadial { start_deg: start, delta_deg: delta, codes: bytes.to_vec() });
    }
    Ok((first_bin, nbins, out))
}

pub fn decode(data: &[u8]) -> Result<Sweep, Error> {
    let (h, msg_start) = parse_header(data)?;
    let sp = spec(h.product_code).ok_or(Error::Unsupported(h.product_code))?;

    // Everything after the 120-byte header + description block may be bzip2.
    let body_start = msg_start + 120;
    if data.len() < body_start {
        return Err(Error::Truncated("product shorter than its header"));
    }
    let owned;
    let buf: &[u8] = if may_be_compressed(h.product_code) && h.dep[7] == 1 {
        let mut out = Vec::with_capacity(data.len() * 6);
        out.extend_from_slice(&data[msg_start..body_start]);
        bzip2::read::BzDecoder::new(&data[body_start..])
            .read_to_end(&mut out)
            .map_err(|_| Error::Format("bzip2 decompression failed"))?;
        owned = out;
        &owned
    } else {
        &data[msg_start..]
    };

    if h.sym_off <= 0 {
        return Err(Error::Format("product has no symbology block"));
    }
    let mut r = Reader::at(buf, h.sym_off as usize * 2)?;
    if r.i16()? != -1 || r.i16()? != 1 {
        return Err(Error::Format("bad symbology block header"));
    }
    let _block_len = r.i32()?;
    let nlayers = r.i16()?;
    let mut radials = None;
    let mut notes: Vec<String> = Vec::new();
    for _ in 0..nlayers.max(0) {
        if r.remaining() < 6 || r.i16()? != -1 {
            break;
        }
        let layer_len = r.i32()? as usize;
        let layer_end = (r.pos() + layer_len).min(buf.len());
        while r.pos() + 4 <= layer_end {
            let code = r.u16()?;
            match code {
                16 => {
                    radials = Some(read_digital_radials(&mut r)?);
                    break;
                }
                // Text packets: length, then position (and colour for 8), then characters.
                1 | 2 | 8 => {
                    let len = r.u16()? as usize;
                    let blk = r.take(len)?;
                    let skip = if code == 8 { 6 } else { 4 };
                    if blk.len() > skip {
                        let t = String::from_utf8_lossy(&blk[skip..]).trim().to_string();
                        if !t.is_empty() {
                            notes.push(t);
                        }
                    }
                }
                // Other packets that start with a byte length: skip them.
                3..=7 | 9..=12 | 15 | 19..=26 => {
                    let len = r.u16()? as usize;
                    r.skip(len)?;
                }
                _ => break,
            }
        }
        if radials.is_some() {
            break;
        }
        r = Reader::at(buf, layer_end)?;
    }
    // A product with no radial packet is a "null product" (nothing to show, e.g.
    // no rain since the storm total reset): return an empty sweep.
    let (first_bin, nbins, raw) = match radials {
        Some(x) if !x.2.is_empty() && x.1 > 0 => x,
        _ => {
            let rows = if matches!(h.product_code, 153 | 154 | 155) { 720 } else { 360 };
            let delta = 360.0 / rows as f64;
            let gates = (sp.range_km / sp.gate_km).round() as usize;
            let raw = (0..rows).map(|i| RawRadial { start_deg: i as f64 * delta, delta_deg: delta, codes: vec![0; gates] }).collect();
            (0, gates, raw)
        }
    };

    let (lut_value, lut_flag, kind) = build_lut(&h);
    let elevation_deg = if sp.has_elevation { h.dep[2] as f64 * 0.1 } else { 0.0 };
    let (supplemental, delta_t) = if sp.has_delta_time {
        let v = h.dep[6] as u16;
        ((v & 0x1f) as u8, (v >> 5) as f64)
    } else {
        (0, 0.0)
    };

    let (az0, delta, rows, codes) = resample(&raw, nbins);
    Ok(Sweep {
        name: sp.name,
        units: sp.units,
        kind,
        elevation_deg,
        scan_time: h.vol_time + delta_t,
        supplemental,
        gate_km: sp.gate_km,
        first_gate_km: first_bin as f64 * sp.gate_km,
        gates: nbins,
        az0,
        delta,
        rows,
        codes,
        lut_value,
        lut_flag,
        extra: extras(&h),
        header: h,
        raw,
        note: notes.first().cloned().unwrap_or_default(),
    })
}

/// Place radials on a uniform azimuth grid aligned to the radar's own radial
/// boundaries, so the renderer can find a radial with one division.
pub fn resample(raw: &[RawRadial], gates: usize) -> (f64, f64, usize, Vec<u8>) {
    let mut deltas: Vec<f64> = raw.iter().map(|r| r.delta_deg).filter(|d| *d > 0.05).collect();
    deltas.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = deltas.get(deltas.len() / 2).copied().unwrap_or(1.0);
    let delta = if (median - 0.5).abs() < 0.15 {
        0.5
    } else if (median - 1.0).abs() < 0.25 {
        1.0
    } else {
        median
    };
    let rows = ((360.0 / delta).round() as usize).max(1);

    // Mean offset of radial starts within one row, averaged on the circle.
    let tau = std::f64::consts::TAU;
    let (mut s, mut c) = (0.0, 0.0);
    for r in raw {
        let center = r.start_deg + r.delta_deg / 2.0;
        let f = (center / delta - 0.5).rem_euclid(1.0);
        s += (tau * f).sin();
        c += (tau * f).cos();
    }
    let frac = (s.atan2(c) / tau).rem_euclid(1.0);
    let az0 = frac * delta;

    let mut codes = vec![0u8; rows * gates];
    let mut filled = vec![false; rows];
    for r in raw {
        let center = r.start_deg + r.delta_deg / 2.0;
        let idx = (((center - az0) / delta - 0.5).round() as i64).rem_euclid(rows as i64) as usize;
        if filled[idx] {
            continue;
        }
        filled[idx] = true;
        let n = r.codes.len().min(gates);
        codes[idx * gates..idx * gates + n].copy_from_slice(&r.codes[..n]);
    }
    // Close single-row gaps so a dropped radial doesn't draw a black spoke.
    for i in 0..rows {
        if !filled[i] {
            let prev = (i + rows - 1) % rows;
            let next = (i + 1) % rows;
            if filled[prev] && filled[next] {
                let (a, b) = (prev * gates, i * gates);
                let src: Vec<u8> = codes[a..a + gates].to_vec();
                codes[b..b + gates].copy_from_slice(&src);
            }
        }
    }
    (az0, delta, rows, codes)
}

impl Sweep {
    /// Physical value at a gate, or None for no data / range folded.
    pub fn value_at(&self, row: usize, gate: usize) -> Option<f32> {
        let c = self.codes[row * self.gates + gate] as usize;
        (self.lut_flag[c] == FLAG_VALID).then(|| self.lut_value[c])
    }
}
