//! NEXRAD Level II (Archive II, message 31) decoder and vertical cross-sections.
//!
//! An Archive II file is a 24-byte volume header followed by bzip2-compressed
//! LDM records, each holding 2432-byte legacy messages or variable-length
//! message 31 radials. Each radial carries one or more data moments (REF, VEL,
//! SW, ZDR, PHI, RHO, CFP). We keep the 8-bit moments as byte codes on a
//! uniform azimuth grid per elevation cut, like the Level III sweeps, so the
//! same rendering and sampling code works on both.

use crate::bytes::Reader;
use crate::geo;
use crate::level3::resample;
use crate::level3::RawRadial;
use crate::Error;
use std::collections::BTreeMap;
use std::io::Read;

pub const MOMENTS: [&str; 5] = ["REF", "VEL", "SW ", "ZDR", "RHO"];

#[derive(Debug, Clone)]
pub struct Cut {
    pub number: u8,
    pub elevation: f64,
    pub time: f64,
    pub moment: [u8; 3],
    pub first_km: f64,
    pub gate_km: f64,
    pub gates: usize,
    pub az0: f64,
    pub delta: f64,
    pub rows: usize,
    pub codes: Vec<u8>,
    /// value = (code - offset) / scale for codes >= 2.
    pub scale: f32,
    pub offset: f32,
}

impl Cut {
    pub fn value(&self, row: usize, gate: usize) -> Option<f32> {
        let c = self.codes[row * self.gates + gate];
        (c >= 2).then(|| (c as f32 - self.offset) / self.scale)
    }

    /// Value at azimuth/slant range, None for no data.
    pub fn sample(&self, az: f64, slant: f64) -> Option<f32> {
        let g = ((slant - self.first_km) / self.gate_km).floor();
        if !(g >= 0.0 && (g as usize) < self.gates) {
            return None;
        }
        let row = (((az - self.az0) / self.delta).floor() as i64).rem_euclid(self.rows as i64) as usize;
        self.value(row, g as usize)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Volume {
    pub site: String,
    pub time: f64,
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
    pub vcp: u16,
    pub cuts: Vec<Cut>,
}

struct Accum {
    elevation_sum: f64,
    n: usize,
    time: f64,
    // moment -> (first_km, gate_km, gates, scale, offset, radials)
    moments: BTreeMap<[u8; 3], (f64, f64, usize, f32, f32, Vec<RawRadial>)>,
}

/// Decompress every LDM record of an Archive II file.
fn records(data: &[u8]) -> Result<Vec<u8>, Error> {
    if data.len() < 24 || &data[..4] != b"AR2V" {
        return Err(Error::Format("not an Archive II file"));
    }
    let mut out = Vec::with_capacity(data.len() * 8);
    let mut off = 24;
    while off + 4 <= data.len() {
        let size = i32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]).unsigned_abs() as usize;
        off += 4;
        if size == 0 || off + size > data.len() {
            break;
        }
        let block = &data[off..off + size];
        if block.starts_with(b"BZh") {
            bzip2::read::BzDecoder::new(block).read_to_end(&mut out).map_err(|_| Error::Format("bad bzip2 record"))?;
        } else {
            out.extend_from_slice(block);
        }
        off += size;
    }
    Ok(out)
}

/// Decode a volume, keeping only the requested 8-bit moments.
pub fn decode(data: &[u8], want: &[&str]) -> Result<Volume, Error> {
    let mut vol = Volume { site: String::from_utf8_lossy(&data[20..24.min(data.len())]).to_string(), ..Default::default() };
    let raw = records(data)?;
    let want: Vec<[u8; 3]> = want.iter().map(|m| {
        let b = m.as_bytes();
        [b[0], b[1], *b.get(2).unwrap_or(&b' ')]
    }).collect();
    let mut cuts: BTreeMap<u8, Accum> = BTreeMap::new();
    let mut off = 0usize;
    while off + 28 <= raw.len() {
        // 12-byte CTM header, then the 16-byte message header.
        let mut h = Reader::at(&raw, off + 12)?;
        let size_hw = h.u16()? as usize;
        let _channel = h.u8()?;
        let mtype = h.u8()?;
        let len = if mtype == 31 { 12 + size_hw * 2 } else { 2432 };
        if mtype == 31 && off + len <= raw.len() && size_hw > 0 {
            parse_31(&raw[off + 28..off + len], &want, &mut cuts, &mut vol)?;
        }
        if len == 0 {
            break;
        }
        off += len;
    }
    for (number, a) in cuts {
        let elevation = a.elevation_sum / a.n.max(1) as f64;
        for (name, (first_km, gate_km, gates, scale, offset, radials)) in a.moments {
            if radials.len() < 10 {
                continue;
            }
            let (az0, delta, rows, codes) = resample(&radials, gates);
            vol.cuts.push(Cut { number, elevation, time: a.time, moment: name, first_km, gate_km, gates, az0, delta, rows, codes, scale, offset });
        }
    }
    if vol.cuts.is_empty() {
        return Err(Error::Format("no usable radials in this volume"));
    }
    Ok(vol)
}

fn parse_31(m: &[u8], want: &[[u8; 3]], cuts: &mut BTreeMap<u8, Accum>, vol: &mut Volume) -> Result<(), Error> {
    let mut r = Reader::new(m);
    r.skip(4)?; // ICAO
    let ms = r.u32()? as f64;
    let date = r.u16()? as f64;
    let _az_num = r.u16()?;
    let az = r.f32()? as f64;
    let _compress = r.u8()?;
    r.skip(1)?;
    let _radial_len = r.u16()?;
    let az_res = r.u8()?;
    let _status = r.u8()?;
    let elev_num = r.u8()?;
    let _cut_sector = r.u8()?;
    let elev = r.f32()? as f64;
    r.skip(2)?;
    let nblocks = r.u16()? as usize;
    let mut ptrs = Vec::with_capacity(nblocks);
    for _ in 0..nblocks.min(10) {
        ptrs.push(r.u32()? as usize);
    }
    let time = (date - 1.0) * 86400.0 + ms / 1000.0;
    let delta = if az_res == 1 { 0.5 } else { 1.0 };
    let acc = cuts.entry(elev_num).or_insert_with(|| Accum { elevation_sum: 0.0, n: 0, time, moments: BTreeMap::new() });
    acc.elevation_sum += elev;
    acc.n += 1;
    for &p in &ptrs {
        if p + 4 > m.len() {
            continue;
        }
        let kind = m[p];
        let name = [m[p + 1], m[p + 2], m[p + 3]];
        if kind == b'R' && &name == b"VOL" && vol.vcp == 0 {
            let mut v = Reader::at(m, p + 4)?;
            v.skip(4)?; // size, version
            vol.lat = v.f32()? as f64;
            vol.lon = v.f32()? as f64;
            vol.height_m = v.i16()? as f64 + v.u16()? as f64;
            v.skip(8)?; // calibration, horizontal/vertical power
            v.skip(4)?; // ZDR calibration
            v.skip(4)?; // initial system differential phase
            vol.vcp = v.u16()?;
            if vol.time == 0.0 {
                vol.time = time;
            }
        }
        if kind != b'D' || !want.contains(&name) {
            continue;
        }
        let mut d = Reader::at(m, p + 4)?;
        d.skip(4)?;
        let ngates = d.u16()? as usize;
        let first_m = d.u16()? as f64;
        let spacing_m = d.u16()? as f64;
        d.skip(4)?; // tover, SNR threshold
        let _flags = d.u8()?;
        let word = d.u8()?;
        let scale = d.f32()?;
        let offset = d.f32()?;
        if word != 8 || ngates == 0 || spacing_m == 0.0 {
            continue;
        }
        let codes = d.take(ngates)?.to_vec();
        let gate_km = spacing_m / 1000.0;
        let entry = acc.moments.entry(name).or_insert_with(|| (first_m / 1000.0 - gate_km / 2.0, gate_km, ngates, scale, offset, Vec::new()));
        entry.5.push(RawRadial { start_deg: az - delta / 2.0, delta_deg: delta, codes });
    }
    Ok(())
}

impl Volume {
    /// Cuts of one moment, lowest elevation first, one per distinct angle.
    pub fn cuts_of(&self, moment: &str) -> Vec<&Cut> {
        let b = moment.as_bytes();
        let key = [b[0], b[1], *b.get(2).unwrap_or(&b' ')];
        let mut v: Vec<&Cut> = self.cuts.iter().filter(|c| c.moment == key).collect();
        v.sort_by(|a, b| a.elevation.partial_cmp(&b.elevation).unwrap().then(b.time.partial_cmp(&a.time).unwrap()));
        v.dedup_by(|a, b| (a.elevation - b.elevation).abs() < 0.15);
        v
    }

    /// Vertical slice from A to B: `nx` columns by `nz` rows (top row = top_km),
    /// heights above the radar. NaN where no beam covers a point. Values are
    /// interpolated in height between the two nearest beams when both see echo.
    pub fn cross_section(&self, moment: &str, a: (f64, f64), b: (f64, f64), nx: usize, nz: usize, top_km: f64) -> Vec<f32> {
        let cuts = self.cuts_of(moment);
        let mut out = vec![f32::NAN; nx * nz];
        if cuts.is_empty() {
            return out;
        }
        let (az_ab, dist) = geo::inverse(a.0, a.1, b.0, b.1);
        let half_beam = (0.95f64 / 2.0).to_radians();
        for ix in 0..nx {
            let t = (ix as f64 + 0.5) / nx as f64;
            let (lat, lon) = geo::destination(a.0, a.1, az_ab, dist * t);
            let (az, ground) = geo::inverse(self.lat, self.lon, lat, lon);
            // Beam centre height and value for every cut at this ground range.
            let beams: Vec<(f64, f64, Option<f32>)> = cuts
                .iter()
                .map(|c| {
                    let slant = geo::slant_range_km(ground, c.elevation);
                    let h = geo::beam_height_km(slant, c.elevation);
                    (h, slant * half_beam, c.sample(az, slant))
                })
                .collect();
            for iz in 0..nz {
                let z = top_km * (1.0 - (iz as f64 + 0.5) / nz as f64);
                // Nearest beam below and above this height.
                let mut below: Option<usize> = None;
                let mut above: Option<usize> = None;
                for (k, &(h, _, _)) in beams.iter().enumerate() {
                    if h <= z && below.is_none_or(|j| beams[j].0 < h) {
                        below = Some(k);
                    }
                    if h > z && above.is_none_or(|j| beams[j].0 > h) {
                        above = Some(k);
                    }
                }
                let v = match (below, above) {
                    (Some(i), Some(j)) => {
                        let (hi, wi, vi) = beams[i];
                        let (hj, wj, vj) = beams[j];
                        match (vi, vj) {
                            (Some(x), Some(y)) => {
                                let f = ((z - hi) / (hj - hi)).clamp(0.0, 1.0) as f32;
                                Some(x + (y - x) * f)
                            }
                            (Some(x), None) if z - hi <= wi => Some(x),
                            (None, Some(y)) if hj - z <= wj => Some(y),
                            _ => None,
                        }
                    }
                    (Some(i), None) => (z - beams[i].0 <= beams[i].1).then_some(beams[i].2).flatten(),
                    (None, Some(j)) => (beams[j].0 - z <= beams[j].1).then_some(beams[j].2).flatten(),
                    _ => None,
                };
                if let Some(v) = v {
                    out[iz * nx + ix] = v;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prints per-cut statistics for a local Archive II file (set WATERGAW_L2),
    /// for comparison with MetPy. Skipped when the variable isn't set.
    #[test]
    fn level2_stats() {
        let Ok(path) = std::env::var("WATERGAW_L2") else { return };
        let data = std::fs::read(path).unwrap();
        let t = std::time::Instant::now();
        let v = decode(&data, &["REF", "VEL", "ZDR", "RHO"]).unwrap();
        println!("decode {:?} site {} vcp {} lat {:.4} lon {:.4} h {} cuts {}", t.elapsed(), v.site, v.vcp, v.lat, v.lon, v.height_m, v.cuts.len());
        for c in &v.cuts {
            let vals: Vec<f32> = (0..c.rows).flat_map(|r| (0..c.gates).filter_map(move |g| c.value(r, g))).collect();
            let mean = vals.iter().map(|&x| x as f64).sum::<f64>() / vals.len().max(1) as f64;
            println!("cut {:2} {} el {:5.2} rows {} gates {} first {:.3} gw {:.3} n {} mean {:.3}", c.number, String::from_utf8_lossy(&c.moment), c.elevation, c.rows, c.gates, c.first_km, c.gate_km, vals.len(), mean);
        }
        let xs = v.cross_section("REF", (29.0, -95.5), (29.6, -94.3), 300, 100, 15.0);
        println!("xsect valid {}", xs.iter().filter(|x| x.is_finite()).count());
    }
}
