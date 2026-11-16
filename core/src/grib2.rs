//! Minimal GRIB2 reader for NOAA MRMS fields (rotation tracks, hail size).
//!
//! MRMS CONUS grids are 14000 x 7000 points on a regular lat/lon grid (grid
//! template 3.0), packed as PNG (data representation template 5.41). Decoding
//! the whole field would need ~200 MB, so [`crop_mercator`] streams the PNG one
//! row at a time and max-pools only the rows and columns inside the requested
//! box onto an output grid whose rows are evenly spaced in Web Mercator, ready
//! to be drawn as a map image. Max-pooling keeps thin hail and rotation swaths
//! visible after downsampling.

use crate::bytes::Reader;
use crate::Error;

#[derive(Debug, Clone)]
pub struct Field<'a> {
    /// Reference time (Unix seconds).
    pub time: f64,
    pub category: u8,
    pub number: u8,
    pub ni: usize,
    pub nj: usize,
    pub la1: f64,
    pub lo1: f64,
    pub di: f64,
    pub dj: f64,
    /// Rows run south to north when true (scanning-mode bit 0x40).
    pub south_first: bool,
    pub r: f64,
    pub e: i32,
    pub d: i32,
    pub bits: u8,
    pub png: &'a [u8],
}

/// GRIB's sign-and-magnitude integers.
fn sm16(v: u16) -> i32 {
    if v & 0x8000 != 0 { -((v & 0x7fff) as i32) } else { v as i32 }
}

fn sm32(v: u32) -> i64 {
    if v & 0x8000_0000 != 0 { -((v & 0x7fff_ffff) as i64) } else { v as i64 }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn parse(data: &[u8]) -> Result<Field<'_>, Error> {
    if data.len() < 16 || &data[..4] != b"GRIB" || data[7] != 2 {
        return Err(Error::Format("not a GRIB2 message"));
    }
    let mut off = 16;
    let mut f = Field {
        time: 0.0, category: 0, number: 0, ni: 0, nj: 0, la1: 0.0, lo1: 0.0, di: 0.0, dj: 0.0,
        south_first: false, r: 0.0, e: 0, d: 0, bits: 0, png: &[],
    };
    let mut have = (false, false, false);
    while off + 5 <= data.len() {
        if &data[off..off + 4] == b"7777" {
            break;
        }
        let mut r = Reader::at(data, off)?;
        let len = r.u32()? as usize;
        let sec = r.u8()?;
        if len < 5 || off + len > data.len() {
            return Err(Error::Truncated("GRIB2 section"));
        }
        let s = &data[off..off + len];
        let mut q = Reader::new(s);
        match sec {
            1 => {
                q.skip(12)?;
                let y = q.u16()? as i64;
                let (mo, d, h, mi, se) = (q.u8()? as i64, q.u8()? as i64, q.u8()? as i64, q.u8()? as i64, q.u8()? as i64);
                f.time = (days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se) as f64;
            }
            3 => {
                q.skip(12)?;
                if q.u16()? != 0 {
                    return Err(Error::Format("only regular lat/lon GRIB2 grids are supported"));
                }
                q.skip(16)?;
                f.ni = q.u32()? as usize;
                f.nj = q.u32()? as usize;
                q.skip(8)?;
                f.la1 = sm32(q.u32()?) as f64 * 1e-6;
                let lo1 = sm32(q.u32()?) as f64 * 1e-6;
                f.lo1 = if lo1 > 180.0 { lo1 - 360.0 } else { lo1 };
                q.skip(9)?;
                f.di = q.u32()? as f64 * 1e-6;
                f.dj = q.u32()? as f64 * 1e-6;
                f.south_first = q.u8()? & 0x40 != 0;
                have.0 = true;
            }
            4 => {
                q.skip(9)?;
                f.category = q.u8()?;
                f.number = q.u8()?;
            }
            5 => {
                q.skip(9)?;
                if q.u16()? != 41 {
                    return Err(Error::Format("only PNG-packed GRIB2 (template 5.41) is supported"));
                }
                f.r = q.f32()? as f64;
                f.e = sm16(q.u16()?);
                f.d = sm16(q.u16()?);
                f.bits = q.u8()?;
                have.1 = true;
            }
            7 => {
                f.png = &s[5..];
                have.2 = true;
            }
            _ => {}
        }
        off += len;
    }
    if !(have.0 && have.1 && have.2) || f.ni == 0 || f.nj == 0 {
        return Err(Error::Format("GRIB2 message is missing sections"));
    }
    Ok(f)
}

fn merc_y(lat: f64) -> f64 {
    let s = lat.clamp(-85.05, 85.05).to_radians().sin();
    0.5 - ((1.0 + s) / (1.0 - s)).ln() / (4.0 * std::f64::consts::PI)
}

/// Max-pooled values inside [lat_s, lat_n] x [lon_w, lon_e] on an out_w x out_h
/// grid (rows evenly spaced in Web Mercator, north row first). Cells with no
/// positive value are NaN.
pub fn crop_mercator(f: &Field, lat_n: f64, lat_s: f64, lon_w: f64, lon_e: f64, out_w: usize, out_h: usize) -> Result<Vec<f32>, Error> {
    let mut out = vec![f32::NAN; out_w * out_h];
    if out_w == 0 || out_h == 0 || lat_n <= lat_s || lon_e <= lon_w {
        return Ok(out);
    }
    let mut dec = png::Decoder::new(std::io::Cursor::new(f.png));
    dec.set_transformations(png::Transformations::IDENTITY);
    let mut reader = dec.read_info().map_err(|_| Error::Format("bad PNG in GRIB2"))?;
    let info = reader.info();
    let bytes_per = match (info.color_type, info.bit_depth) {
        (png::ColorType::Grayscale, png::BitDepth::Eight) => 1,
        (png::ColorType::Grayscale, png::BitDepth::Sixteen) => 2,
        _ => return Err(Error::Format("unsupported PNG layout in GRIB2")),
    };
    if info.width as usize != f.ni {
        return Err(Error::Format("PNG width doesn't match the grid"));
    }
    let scale = 2f64.powi(f.e);
    let dscale = 10f64.powi(-f.d);
    let (yn, ys) = (merc_y(lat_n), merc_y(lat_s));
    // Column range and the output column of each input column.
    let i0 = (((lon_w - f.lo1) / f.di).floor().max(0.0) as usize).min(f.ni);
    let i1 = (((lon_e - f.lo1) / f.di).ceil().max(0.0) as usize).min(f.ni);
    let cols: Vec<usize> = (i0..i1)
        .map(|i| ((((f.lo1 + i as f64 * f.di) - lon_w) / (lon_e - lon_w) * out_w as f64) as usize).min(out_w - 1))
        .collect();
    let mut j = 0usize;
    while let Some(row) = reader.next_row().map_err(|_| Error::Format("bad PNG row in GRIB2"))? {
        let lat = if f.south_first { f.la1 + j as f64 * f.dj } else { f.la1 - j as f64 * f.dj };
        j += 1;
        if lat > lat_n || lat < lat_s {
            // Rows run monotonically, so stop once we've passed the box.
            if (!f.south_first && lat < lat_s) || (f.south_first && lat > lat_n) {
                break;
            }
            continue;
        }
        let oy = (((merc_y(lat) - yn) / (ys - yn)) * out_h as f64) as usize;
        if oy >= out_h {
            continue;
        }
        let data = row.data();
        let base = oy * out_w;
        for (k, i) in (i0..i1).enumerate() {
            let x = if bytes_per == 2 { u16::from_be_bytes([data[2 * i], data[2 * i + 1]]) as f64 } else { data[i] as f64 };
            let v = ((f.r + x * scale) * dscale) as f32;
            if v > 0.0 {
                let cell = &mut out[base + cols[k]];
                if !(*cell >= v) {
                    *cell = v;
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mrms_rotation_track_parses_and_crops() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/MRMS_RotationTrack60min.grib2");
        let data = std::fs::read(path).unwrap();
        let f = parse(&data).unwrap();
        assert_eq!((f.ni, f.nj), (14000, 7000));
        assert!((f.la1 - 54.9975).abs() < 1e-3 && (f.lo1 + 129.9975).abs() < 1e-3, "{} {}", f.la1, f.lo1);
        assert!((f.di - 0.005).abs() < 1e-6);
        assert!(f.time > 1.7e9);
        // Whole CONUS at low resolution. MRMS stores rotation in units of 0.001 s^-1;
        // pygrib (eccodes) reads this file as max 55, median 3.
        let out = crop_mercator(&f, 54.99, 20.01, -129.99, -60.01, 700, 350).unwrap();
        let vals: Vec<f32> = out.iter().copied().filter(|v| v.is_finite()).collect();
        assert!(!vals.is_empty());
        let max = vals.iter().cloned().fold(0.0, f32::max);
        assert_eq!(max, 55.0, "max {max}");
    }

    #[test]
    fn sign_magnitude() {
        assert_eq!(sm16(0x8003), -3);
        assert_eq!(sm16(3), 3);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 11, 16), 20773);
    }
}
