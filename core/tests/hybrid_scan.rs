//! Hybrid scan reflectivity (DHR, product 32): the small, ground-level
//! reflectivity product the phone app uses for background checks and widgets.
//! Checked against super-res base reflectivity from the same volume.

use watergaw_core::level3::{decode, Sweep};
use watergaw_core::nowcast::{estimate_motion, point_series, to_grid, Grid, Polar};

fn read(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn grid(s: &Sweep, floor: f32) -> Grid {
    let lut: Vec<f32> = s.lut_value.to_vec();
    let p = Polar {
        codes: &s.codes, lut: &lut, rows: s.rows, gates: s.gates, gate_km: s.gate_km,
        first_km: s.first_gate_km, az0: s.az0, delta: s.delta, elev: s.elevation_deg,
    };
    to_grid(&p, 2.0, floor)
}

#[test]
fn decodes_hybrid_scan_reflectivity() {
    let s = decode(&read("MUX_DHR_2.l3")).unwrap();
    assert_eq!(s.header.product_code, 32);
    assert_eq!(s.name, "Hybrid Scan Reflectivity");
    assert_eq!(s.rows, 360);
    assert!((s.gate_km - 1.0).abs() < 1e-9);
    assert!(s.gates >= 230, "{} gates", s.gates);
    let finite: Vec<f32> = s.lut_value.iter().copied().filter(|v| v.is_finite()).collect();
    let (lo, hi) = (finite.iter().cloned().fold(f32::MAX, f32::min), finite.iter().cloned().fold(f32::MIN, f32::max));
    println!("DHR values {lo} .. {hi} dBZ");
    assert!(lo <= -30.0 && hi >= 70.0);
}

/// Rain in the hybrid scan sits where the 0.5° super-res scan sees it.
#[test]
fn lines_up_with_base_reflectivity() {
    let dhr = grid(&decode(&read("MUX_DHR_2.l3")).unwrap(), 20.0);
    let base = grid(&decode(&read("MUX_N0B_2.l3")).unwrap(), 20.0);
    let iou = |flip: f64| {
        let (mut both, mut either) = (0usize, 0usize);
        for j in 0..dhr.n {
            for i in 0..dhr.n {
                let x = -dhr.half + (i as f64 + 0.5) * dhr.cell;
                let y = -dhr.half + (j as f64 + 0.5) * dhr.cell;
                if x * x + y * y > 180.0 * 180.0 { continue; }
                let a = dhr.at(x, y) > 0.0;
                let b = base.at(x, flip * y) > 0.0;
                both += (a && b) as usize;
                either += (a || b) as usize;
            }
        }
        both as f64 / either.max(1) as f64
    };
    let (good, flipped) = (iou(1.0), iou(-1.0));
    println!("rain overlap {good:.2}, flipped {flipped:.2}");
    // DHR switches to higher beams where hills block the lowest one, so it
    // never matches the 0.5° scan exactly.
    assert!(good > 0.4, "got {good:.2}");
    assert!(good > 3.0 * flipped);
}

#[test]
fn nowcast_at_a_point() {
    let a = decode(&read("MUX_DHR_1.l3")).unwrap();
    let b = decode(&read("MUX_DHR_2.l3")).unwrap();
    let dt = b.scan_time - a.scan_time;
    assert!(dt > 200.0 && dt < 700.0, "scans {dt} s apart");
    let (g0, g1) = (grid(&a, 18.0), grid(&b, 18.0));
    let m = estimate_motion(&g0, &g1, dt);
    assert!(m.valid > 0);
    let (u, v) = m.mean();
    let kmh = (u * u + v * v).sqrt() * 3600.0;
    println!("motion {kmh:.0} km/h toward {:.0}°", u.atan2(v).to_degrees().rem_euclid(360.0));
    assert!(kmh < 150.0);
    let s = point_series(&g1, &m, 30.0, -20.0, &[0.0, 600.0, 1800.0, 3600.0]);
    assert_eq!(s[0], g1.at(30.0, -20.0));
    // Far outside the radar's view nothing is known.
    assert!(point_series(&g1, &m, 400.0, 0.0, &[0.0])[0].is_nan());
}
