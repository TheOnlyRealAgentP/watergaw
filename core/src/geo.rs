//! Radar beam geometry and map projection.
//!
//! Beam paths use the standard 4/3 effective-earth-radius model (Doviak &
//! Zrnić 1993, eq. 2.28): the height of the beam centre at slant range r and
//! elevation θ is h = sqrt(r² + R² + 2rR·sinθ) − R with R = 4/3 · a.

pub const EARTH_RADIUS_KM: f64 = 6371.0088;
pub const EFFECTIVE_RADIUS_KM: f64 = EARTH_RADIUS_KM * 4.0 / 3.0;

/// Height of the beam centre above the radar, km.
pub fn beam_height_km(slant_km: f64, elev_deg: f64) -> f64 {
    let r = slant_km;
    let re = EFFECTIVE_RADIUS_KM;
    (r * r + re * re + 2.0 * r * re * elev_deg.to_radians().sin()).sqrt() - re
}

/// Distance along the ground under the beam, km.
pub fn ground_range_km(slant_km: f64, elev_deg: f64) -> f64 {
    let re = EFFECTIVE_RADIUS_KM;
    let h = beam_height_km(slant_km, elev_deg);
    re * (slant_km * elev_deg.to_radians().cos() / (re + h)).asin()
}

/// Inverse of [`ground_range_km`]: slant range of the beam above a ground distance.
pub fn slant_range_km(ground_km: f64, elev_deg: f64) -> f64 {
    let re = EFFECTIVE_RADIUS_KM;
    let phi = ground_km / re;
    re * phi.sin() / (phi + elev_deg.to_radians()).cos()
}

/// Point reached by travelling `dist_km` from (lat, lon) on initial bearing `az_deg`.
pub fn destination(lat: f64, lon: f64, az_deg: f64, dist_km: f64) -> (f64, f64) {
    let (p1, l1) = (lat.to_radians(), lon.to_radians());
    let d = dist_km / EARTH_RADIUS_KM;
    let t = az_deg.to_radians();
    let p2 = (p1.sin() * d.cos() + p1.cos() * d.sin() * t.cos()).asin();
    let l2 = l1 + (t.sin() * d.sin() * p1.cos()).atan2(d.cos() - p1.sin() * p2.sin());
    (p2.to_degrees(), ((l2.to_degrees() + 540.0) % 360.0) - 180.0)
}

/// Initial bearing (degrees from north) and great-circle distance (km) from point 1 to point 2.
pub fn inverse(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> (f64, f64) {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dl = (lon2 - lon1).to_radians();
    let dp = p2 - p1;
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    let dist = 2.0 * EARTH_RADIUS_KM * a.sqrt().atan2((1.0 - a).sqrt());
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    let az = y.atan2(x).to_degrees().rem_euclid(360.0);
    (az, dist)
}

/// Web Mercator in the 0..1 unit square used by MapLibre ([0,0] is the north-west corner).
pub fn mercator(lat: f64, lon: f64) -> (f64, f64) {
    let x = (lon + 180.0) / 360.0;
    let s = lat.clamp(-85.051129, 85.051129).to_radians();
    let y = 0.5 - ((std::f64::consts::FRAC_PI_4 + s / 2.0).tan().ln()) / (2.0 * std::f64::consts::PI);
    (x, y)
}

/// Mesh for one radar sweep, relative to the radar so float32 stays precise.
///
/// Vertices are `[dx, dy, azimuth_deg, slant_range_km]` where dx/dy are Web
/// Mercator offsets from the radar. The fragment shader turns the interpolated
/// azimuth and range into a texel, so the mesh only has to be fine enough to
/// keep the beam's curvature smooth.
pub fn sweep_mesh(lat: f64, lon: f64, elev_deg: f64, max_range_km: f64, n_az: usize, n_rings: usize) -> (Vec<f32>, Vec<u32>) {
    let (x0, y0) = mercator(lat, lon);
    let mut verts = Vec::with_capacity((n_az + 1) * (n_rings + 1) * 4);
    for j in 0..=n_az {
        let az = j as f64 * 360.0 / n_az as f64;
        for k in 0..=n_rings {
            let slant = k as f64 * max_range_km / n_rings as f64;
            let ground = ground_range_km(slant, elev_deg);
            let (la, lo) = destination(lat, lon, az, ground);
            let (x, y) = mercator(la, lo);
            verts.extend_from_slice(&[(x - x0) as f32, (y - y0) as f32, az as f32, slant as f32]);
        }
    }
    let stride = (n_rings + 1) as u32;
    let mut idx = Vec::with_capacity(n_az * n_rings * 6);
    for j in 0..n_az as u32 {
        for k in 0..n_rings as u32 {
            let a = j * stride + k;
            let b = a + stride;
            idx.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    (verts, idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slant_ground_round_trip() {
        for &el in &[0.5, 1.3, 3.1, 10.0, 19.5] {
            for &r in &[1.0, 50.0, 230.0, 460.0] {
                let s = ground_range_km(r, el);
                assert!((slant_range_km(s, el) - r).abs() < 1e-6, "el {el} r {r}");
            }
        }
    }

    #[test]
    fn beam_height_matches_textbook() {
        // 0.5° beam at 230 km is about 5.1 km above the radar.
        let h = beam_height_km(230.0, 0.5);
        assert!((h - 5.1).abs() < 0.1, "{h}");
    }

    #[test]
    fn destination_inverse_round_trip() {
        let (lat, lon) = (35.333, -97.278);
        for az in [0.0, 45.0, 137.0, 270.0, 359.0] {
            let (la, lo) = destination(lat, lon, az, 180.0);
            let (a, d) = inverse(lat, lon, la, lo);
            assert!((d - 180.0).abs() < 1e-6);
            assert!(((a - az + 540.0) % 360.0 - 180.0).abs() < 1e-6);
        }
    }
}
