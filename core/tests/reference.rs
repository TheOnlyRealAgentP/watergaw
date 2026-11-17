//! Checks the Level III decoder against MetPy (see tools/l3_reference.py).

use watergaw_core::level3::{self, FLAG_VALID};
use serde_json::Value;
use std::path::PathBuf;

fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-4 * (1.0 + b.abs())
}

#[test]
fn null_product_decodes_as_empty() {
    // KMTX storm total with no rain since the last reset: only text packets.
    let data = std::fs::read(data_dir().join("MTX_DTA_null.bin")).unwrap();
    let s = level3::decode(&data).unwrap();
    assert_eq!(s.header.product_code, 172);
    assert!(s.codes.iter().all(|&c| c == 0));
    assert_eq!((s.rows, s.gates), (360, 920));
    assert!(s.note.starts_with("No precipitation detected"), "{}", s.note);
}

#[test]
fn level3_matches_metpy() {
    let mut checked = 0;
    for entry in std::fs::read_dir(data_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("l3") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let data = std::fs::read(&path).unwrap();
        let reference: Value =
            serde_json::from_str(&std::fs::read_to_string(path.with_extension("l3.ref.json")).unwrap()).unwrap();
        let s = level3::decode(&data).unwrap_or_else(|e| panic!("{name}: {e}"));

        assert_eq!(s.header.product_code as i64, reference["code"].as_i64().unwrap(), "{name} code");
        assert!(close(s.header.lat, reference["lat"].as_f64().unwrap()), "{name} lat");
        assert!(close(s.header.lon, reference["lon"].as_f64().unwrap()), "{name} lon");
        assert!(close(s.header.vol_time, reference["vol_time"].as_f64().unwrap()), "{name} time");
        if let Some(el) = reference["elevation"].as_f64() {
            assert!(close(s.elevation_deg, el), "{name} elevation {} vs {el}", s.elevation_deg);
        }
        // Radials are padded to whole halfwords, so MetPy may count one extra (empty) gate.
        let ref_bins = reference["nbins"].as_i64().unwrap();
        assert!(s.gates as i64 == ref_bins || s.gates as i64 + 1 == ref_bins && s.gates % 2 == 1, "{name} gates");
        assert_eq!(s.header.awips_site, name[..3], "{name} radar id");

        // Every radial: angles, number of valid gates and their sum.
        let radials = reference["radials"].as_array().unwrap();
        assert_eq!(s.raw.len(), radials.len(), "{name} radial count");
        for (i, (raw, r)) in s.raw.iter().zip(radials).enumerate() {
            let r = r.as_array().unwrap();
            assert!(close(raw.start_deg, r[0].as_f64().unwrap()), "{name} radial {i} start");
            let mut n = 0i64;
            let mut sum = 0f64;
            for &c in raw.codes.iter().take(s.gates) {
                if s.lut_flag[c as usize] == FLAG_VALID {
                    n += 1;
                    sum += s.lut_value[c as usize] as f64;
                }
            }
            assert_eq!(n, r[2].as_i64().unwrap(), "{name} radial {i} valid count");
            let want = r[3].as_f64().unwrap();
            assert!((sum - want).abs() <= 1e-3 * (1.0 + want.abs()), "{name} radial {i} sum {sum} vs {want}");
        }

        // Single gates, exactly.
        for spot in reference["spots"].as_array().unwrap() {
            let spot = spot.as_array().unwrap();
            let (i, j) = (spot[0].as_u64().unwrap() as usize, spot[1].as_u64().unwrap() as usize);
            let c = s.raw[i].codes[j] as usize;
            let ours = (s.lut_flag[c] == FLAG_VALID).then(|| s.lut_value[c] as f64);
            match (ours, spot[2].as_f64()) {
                (Some(a), Some(b)) => assert!(close(a, b), "{name} gate {i},{j}: {a} vs {b}"),
                (None, None) => {}
                (a, b) => panic!("{name} gate {i},{j}: {a:?} vs {b:?}"),
            }
        }

        // Resampling: each radial lands in its own row, and that row holds its data.
        let mut seen = vec![false; s.rows];
        for raw in &s.raw {
            let center = raw.start_deg + raw.delta_deg / 2.0;
            let row = (((center - s.az0) / s.delta - 0.5).round() as i64).rem_euclid(s.rows as i64) as usize;
            assert!(!seen[row], "{name}: two radials share row {row}");
            seen[row] = true;
            let n = raw.codes.len().min(s.gates);
            assert_eq!(&s.codes[row * s.gates..row * s.gates + n], &raw.codes[..n], "{name} row {row}");
            // The row's span must contain the radial centre.
            let row_start = s.az0 + row as f64 * s.delta;
            let off = (center - row_start).rem_euclid(360.0);
            assert!(off <= s.delta + 0.11, "{name}: centre {center} not in row starting {row_start}");
        }
        checked += 1;
    }
    assert!(checked >= 10, "only {checked} reference files found");
}
