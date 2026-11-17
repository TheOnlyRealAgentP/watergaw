//! Rain nowcast: "future radar" for the next hour.
//!
//! 1. Both scans are put on a 2 km Cartesian grid around the radar.
//! 2. Motion comes from block matching: each 32 km block of the newer scan is
//!    matched to the best-fitting offset of the older scan (sum of absolute
//!    differences, sub-cell parabolic refinement). Blocks without much rain are
//!    skipped, gaps are filled by inverse-distance weighting, and the field is
//!    median- then mean-filtered.
//! 3. Each future frame is built in the radar's own polar layout by semi-
//!    Lagrangian backtracking: every gate looks upwind along the motion field
//!    and copies whatever the latest scan had there. Reusing the polar layout
//!    means the renderer, inspector and legend work on forecasts unchanged.
//!
//! It is extrapolation (storms keep their current motion and strength), which
//! is what nowcasts in other radar apps do too; the app labels it as such.

use crate::geo;

/// A decoded sweep: byte codes plus the 256-entry code-to-value table.
pub struct Polar<'a> {
    pub codes: &'a [u8],
    /// Physical value per code; NaN where the code means "no data".
    pub lut: &'a [f32],
    pub rows: usize,
    pub gates: usize,
    pub gate_km: f64,
    pub first_km: f64,
    pub az0: f64,
    pub delta: f64,
    pub elev: f64,
}

/// Ground range -> slant range lookup, so sampling avoids trig per gate.
struct SlantTable {
    step: f64,
    slant: Vec<f64>,
}

impl SlantTable {
    fn new(elev: f64, max_ground: f64) -> Self {
        let step = 0.1;
        let n = (max_ground / step) as usize + 2;
        Self { step, slant: (0..n).map(|i| geo::slant_range_km(i as f64 * step, elev)).collect() }
    }
    fn get(&self, ground: f64) -> f64 {
        let f = ground / self.step;
        let i = f as usize;
        if i + 1 >= self.slant.len() {
            return f64::INFINITY;
        }
        let t = f - i as f64;
        self.slant[i] * (1.0 - t) + self.slant[i + 1] * t
    }
}

impl Polar<'_> {
    fn max_km(&self) -> f64 {
        self.first_km + self.gates as f64 * self.gate_km
    }

    /// Code of the gate under a point `x` km east, `y` km north of the radar (0 outside).
    fn code_at(&self, x: f64, y: f64, slant: &SlantTable) -> u8 {
        let ground = (x * x + y * y).sqrt();
        let r = slant.get(ground);
        let g = ((r - self.first_km) / self.gate_km).floor();
        if !(g >= 0.0 && (g as usize) < self.gates) {
            return 0;
        }
        let az = x.atan2(y).to_degrees();
        let row = (((az - self.az0) / self.delta).floor() as i64).rem_euclid(self.rows as i64) as usize;
        self.codes[row * self.gates + g as usize]
    }

    fn value_at(&self, x: f64, y: f64, slant: &SlantTable) -> f32 {
        let v = self.lut[self.code_at(x, y, slant) as usize];
        if v.is_finite() { v } else { f32::NAN }
    }
}

/// Square Cartesian grid centred on the radar: cell (i, j) has its centre at
/// x = -half + (i + 0.5) * cell, y = -half + (j + 0.5) * cell (j grows north).
pub struct Grid {
    pub n: usize,
    pub cell: f64,
    pub half: f64,
    pub data: Vec<f32>,
}

/// Rain-only reflectivity grid (dBZ below `floor` and missing gates become 0).
pub fn to_grid(p: &Polar, cell: f64, floor: f32) -> Grid {
    let half = p.max_km().min(460.0);
    let n = (2.0 * half / cell).ceil() as usize;
    let slant = SlantTable::new(p.elev, half * 1.5);
    let mut data = vec![0f32; n * n];
    for j in 0..n {
        let y = -half + (j as f64 + 0.5) * cell;
        for i in 0..n {
            let x = -half + (i as f64 + 0.5) * cell;
            let v = p.value_at(x, y, &slant);
            data[j * n + i] = if v.is_finite() && v >= floor { v } else { 0.0 };
        }
    }
    Grid { n, cell, half, data }
}

impl Grid {
    /// Value of the cell under (x, y) km; NaN outside the radar's circle.
    pub fn at(&self, x: f64, y: f64) -> f32 {
        if x * x + y * y > self.half * self.half {
            return f32::NAN;
        }
        let i = ((x + self.half) / self.cell).floor();
        let j = ((y + self.half) / self.cell).floor();
        if i < 0.0 || j < 0.0 || i >= self.n as f64 || j >= self.n as f64 {
            return f32::NAN;
        }
        self.data[j as usize * self.n + i as usize]
    }
}

/// What a point will see over the next hour: the value arriving at (x, y) km
/// after each `taus` seconds, by tracing the motion field back upwind (the
/// same two-step backtrack [`advect`] uses). NaN once the source is outside
/// the radar's view.
pub fn point_series(cur: &Grid, m: &Motion, x: f64, y: f64, taus: &[f64]) -> Vec<f32> {
    taus.iter()
        .map(|&tau| {
            let (u1, v1) = m.sample(x, y);
            let (mx, my) = (x - u1 * tau / 2.0, y - v1 * tau / 2.0);
            let (u2, v2) = m.sample(mx, my);
            cur.at(x - u2 * tau, y - v2 * tau)
        })
        .collect()
}

/// Motion vectors (km/s east and north) on a coarse grid of block centres.
pub struct Motion {
    pub nb: usize,
    /// Distance between block centres, km.
    pub spacing: f64,
    pub half: f64,
    pub u: Vec<f32>,
    pub v: Vec<f32>,
    pub valid: usize,
}

impl Motion {
    pub fn zero(half: f64) -> Self {
        Motion { nb: 1, spacing: 2.0 * half, half, u: vec![0.0], v: vec![0.0], valid: 0 }
    }

    pub fn uniform(half: f64, u: f32, v: f32) -> Self {
        Motion { nb: 1, spacing: 2.0 * half, half, u: vec![u], v: vec![v], valid: 0 }
    }

    /// Bilinear sample at (x, y) km; clamps to the edge blocks.
    pub fn sample(&self, x: f64, y: f64) -> (f64, f64) {
        if self.nb == 1 {
            return (self.u[0] as f64, self.v[0] as f64);
        }
        let fi = ((x + self.half) / self.spacing - 0.5).clamp(0.0, (self.nb - 1) as f64);
        let fj = ((y + self.half) / self.spacing - 0.5).clamp(0.0, (self.nb - 1) as f64);
        let (i0, j0) = (fi.floor() as usize, fj.floor() as usize);
        let (i1, j1) = ((i0 + 1).min(self.nb - 1), (j0 + 1).min(self.nb - 1));
        let (tx, ty) = (fi - i0 as f64, fj - j0 as f64);
        let at = |f: &Vec<f32>, i: usize, j: usize| f[j * self.nb + i] as f64;
        let lerp = |f: &Vec<f32>| {
            let a = at(f, i0, j0) * (1.0 - tx) + at(f, i1, j0) * tx;
            let b = at(f, i0, j1) * (1.0 - tx) + at(f, i1, j1) * tx;
            a * (1.0 - ty) + b * ty
        };
        (lerp(&self.u), lerp(&self.v))
    }

    /// Mean vector over the blocks that had rain to track.
    pub fn mean(&self) -> (f64, f64) {
        let n = self.u.len() as f64;
        (self.u.iter().map(|&x| x as f64).sum::<f64>() / n, self.v.iter().map(|&x| x as f64).sum::<f64>() / n)
    }
}

/// Estimate motion from `prev` to `cur` (same grid), `dt` seconds apart.
pub fn estimate_motion(prev: &Grid, cur: &Grid, dt: f64) -> Motion {
    let n = cur.n;
    let cell = cur.cell;
    let block = 16usize;
    let step = 8usize;
    // Allow up to ~160 km/h of storm motion.
    let reach = ((160.0 / 3600.0 * dt) / cell).ceil().clamp(2.0, 14.0) as i64;
    let margin = reach as usize;
    if n < block + 2 * margin + 2 || dt <= 0.0 {
        return Motion::zero(cur.half);
    }
    let nb = (n - block) / step + 1;
    let mut u = vec![f32::NAN; nb * nb];
    let mut v = vec![f32::NAN; nb * nb];
    let mut valid = 0;
    let at = |g: &Grid, i: i64, j: i64| -> f32 {
        if i < 0 || j < 0 || i >= n as i64 || j >= n as i64 { 0.0 } else { g.data[j as usize * n + i as usize] }
    };
    for bj in 0..nb {
        for bi in 0..nb {
            let (x0, y0) = ((bi * step) as i64, (bj * step) as i64);
            let rainy = (0..block as i64)
                .flat_map(|dy| (0..block as i64).map(move |dx| (dx, dy)))
                .filter(|&(dx, dy)| at(cur, x0 + dx, y0 + dy) >= 20.0)
                .count();
            if rainy < block * block / 8 {
                continue;
            }
            let sad = |ox: i64, oy: i64| -> f64 {
                let mut s = 0.0f64;
                for dy in 0..block as i64 {
                    for dx in 0..block as i64 {
                        s += (at(cur, x0 + dx, y0 + dy) - at(prev, x0 + dx - ox, y0 + dy - oy)).abs() as f64;
                    }
                }
                s
            };
            let w = (2 * reach + 1) as usize;
            let mut table = vec![0f64; w * w];
            let (mut best, mut bx, mut by) = (f64::INFINITY, 0i64, 0i64);
            for oy in -reach..=reach {
                for ox in -reach..=reach {
                    let s = sad(ox, oy);
                    table[(oy + reach) as usize * w + (ox + reach) as usize] = s;
                    // Prefer smaller displacements on ties.
                    if s < best - 1e-9 || (s - best).abs() < 1e-9 && ox * ox + oy * oy < bx * bx + by * by {
                        best = s;
                        bx = ox;
                        by = oy;
                    }
                }
            }
            // Sub-cell refinement with a parabola through the neighbours.
            let t = |ox: i64, oy: i64| table[(oy + reach) as usize * w + (ox + reach) as usize];
            let refine = |m: f64, l: f64, r: f64| {
                let d = l - 2.0 * m + r;
                if d > 1e-9 { (0.5 * (l - r) / d).clamp(-0.5, 0.5) } else { 0.0 }
            };
            let fx = if bx.abs() < reach { refine(best, t(bx - 1, by), t(bx + 1, by)) } else { 0.0 };
            let fy = if by.abs() < reach { refine(best, t(bx, by - 1), t(bx, by + 1)) } else { 0.0 };
            let k = bj * nb + bi;
            u[k] = (((bx as f64 + fx) * cell) / dt) as f32;
            v[k] = (((by as f64 + fy) * cell) / dt) as f32;
            valid += 1;
        }
    }
    let spacing = step as f64 * cell;
    // Block centres sit half a block in from each block's corner.
    let offset = (block as f64 / 2.0) * cell - spacing / 2.0;
    let mut m = Motion { nb, spacing, half: cur.half - offset, u, v, valid };
    if valid == 0 {
        return Motion::zero(cur.half);
    }
    fill_and_smooth(&mut m);
    m
}

fn fill_and_smooth(m: &mut Motion) {
    let nb = m.nb;
    let known: Vec<(usize, usize, f32, f32)> = (0..nb * nb)
        .filter(|&k| m.u[k].is_finite())
        .map(|k| (k % nb, k / nb, m.u[k], m.v[k]))
        .collect();
    // Median filter the known vectors against their known neighbours to drop outliers.
    let mut clean = known.clone();
    for c in clean.iter_mut() {
        let mut us = vec![];
        let mut vs = vec![];
        for &(i, j, u, v) in &known {
            if (i as i64 - c.0 as i64).abs() <= 1 && (j as i64 - c.1 as i64).abs() <= 1 {
                us.push(u);
                vs.push(v);
            }
        }
        us.sort_by(|a, b| a.partial_cmp(b).unwrap());
        vs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        c.2 = us[us.len() / 2];
        c.3 = vs[vs.len() / 2];
    }
    // Inverse-distance fill everywhere.
    for j in 0..nb {
        for i in 0..nb {
            let (mut su, mut sv, mut sw) = (0f64, 0f64, 0f64);
            for &(ki, kj, u, v) in &clean {
                let d2 = ((ki as f64 - i as f64).powi(2) + (kj as f64 - j as f64).powi(2)).max(0.25);
                let w = 1.0 / d2;
                su += u as f64 * w;
                sv += v as f64 * w;
                sw += w;
            }
            m.u[j * nb + i] = (su / sw) as f32;
            m.v[j * nb + i] = (sv / sw) as f32;
        }
    }
    // Two passes of a 3x3 mean.
    for _ in 0..2 {
        let (u0, v0) = (m.u.clone(), m.v.clone());
        for j in 0..nb {
            for i in 0..nb {
                let (mut su, mut sv, mut c) = (0f32, 0f32, 0f32);
                for dj in -1i64..=1 {
                    for di in -1i64..=1 {
                        let (a, b) = (i as i64 + di, j as i64 + dj);
                        if a >= 0 && b >= 0 && (a as usize) < nb && (b as usize) < nb {
                            su += u0[b as usize * nb + a as usize];
                            sv += v0[b as usize * nb + a as usize];
                            c += 1.0;
                        }
                    }
                }
                m.u[j * nb + i] = su / c;
                m.v[j * nb + i] = sv / c;
            }
        }
    }
}

/// Future sweep `tau` seconds ahead, in the same polar layout as `cur`.
pub fn advect(cur: &Polar, m: &Motion, tau: f64) -> Vec<u8> {
    let mut out = vec![0u8; cur.rows * cur.gates];
    let slant = SlantTable::new(cur.elev, cur.max_km() * 1.5);
    let grounds: Vec<f64> = (0..cur.gates)
        .map(|g| geo::ground_range_km(cur.first_km + (g as f64 + 0.5) * cur.gate_km, cur.elev))
        .collect();
    for row in 0..cur.rows {
        let az = (cur.az0 + (row as f64 + 0.5) * cur.delta).to_radians();
        let (s, c) = az.sin_cos();
        for (g, &ground) in grounds.iter().enumerate() {
            let (x, y) = (ground * s, ground * c);
            // Two-step semi-Lagrangian backtrack (velocity at the midpoint).
            let (u1, v1) = m.sample(x, y);
            let (mx, my) = (x - u1 * tau / 2.0, y - v1 * tau / 2.0);
            let (u2, v2) = m.sample(mx, my);
            out[row * cur.gates + g] = cur.code_at(x - u2 * tau, y - v2 * tau, &slant);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic sweep with Gaussian "storms" at the given (x, y, peak dBZ).
    fn sweep(blobs: &[(f64, f64, f64)]) -> (Vec<u8>, Vec<f32>) {
        let (rows, gates, gate_km) = (360usize, 920usize, 0.25);
        let mut lut = vec![f32::NAN; 256];
        for c in 2..256 {
            lut[c] = -32.0 + (c - 2) as f32 * 0.5;
        }
        let mut codes = vec![0u8; rows * gates];
        for r in 0..rows {
            let az = ((r as f64 + 0.5) * 1.0).to_radians();
            for g in 0..gates {
                let rng = (g as f64 + 0.5) * gate_km;
                let (x, y) = (rng * az.sin(), rng * az.cos());
                let mut dbz = 0.0f64;
                for &(bx, by, peak) in blobs {
                    let d2 = (x - bx).powi(2) + (y - by).powi(2);
                    dbz = dbz.max(peak * (-d2 / (2.0 * 18f64.powi(2))).exp());
                }
                if dbz >= 15.0 {
                    codes[r * gates + g] = ((dbz + 32.0) / 0.5) as u8 + 2;
                }
            }
        }
        (codes, lut)
    }

    fn polar<'a>(codes: &'a [u8], lut: &'a [f32]) -> Polar<'a> {
        Polar { codes, lut, rows: 360, gates: 920, gate_km: 0.25, first_km: 0.0, az0: 0.0, delta: 1.0, elev: 0.0 }
    }

    #[test]
    fn recovers_known_motion_and_moves_storms() {
        // Storms move 6 km east and 4 km north in 300 s (72 km/h at 56°).
        let start = [(-60.0, 20.0, 55.0), (40.0, -50.0, 50.0), (10.0, 80.0, 45.0)];
        let moved: Vec<_> = start.iter().map(|&(x, y, p)| (x + 6.0, y + 4.0, p)).collect();
        let (c0, lut) = sweep(&start);
        let (c1, _) = sweep(&moved);
        let (p0, p1) = (polar(&c0, &lut), polar(&c1, &lut));
        let (g0, g1) = (to_grid(&p0, 2.0, 15.0), to_grid(&p1, 2.0, 15.0));
        let m = estimate_motion(&g0, &g1, 300.0);
        assert!(m.valid > 3, "only {} blocks tracked", m.valid);
        let (u, v) = m.sample(-60.0, 20.0);
        assert!((u * 300.0 - 6.0).abs() < 1.0 && (v * 300.0 - 4.0).abs() < 1.0, "motion {} {}", u * 300.0, v * 300.0);

        // Advect 15 more minutes: the first storm's core should now sit 18 km E, 12 km N further.
        let future = advect(&p1, &m, 900.0);
        let pf = polar(&future, &lut);
        let slant = SlantTable::new(0.0, 700.0);
        let core = pf.value_at(-60.0 + 6.0 + 18.0, 20.0 + 4.0 + 12.0, &slant);
        let old = pf.value_at(-60.0 + 6.0, 20.0 + 4.0, &slant);
        assert!(core > 50.0, "core {core}");
        assert!(!(old > core - 3.0), "old spot {old} should be weaker than the moved core {core}");
    }

    #[test]
    fn no_rain_means_no_motion() {
        let (c, lut) = sweep(&[]);
        let p = polar(&c, &lut);
        let g = to_grid(&p, 2.0, 15.0);
        let m = estimate_motion(&g, &g, 300.0);
        assert_eq!(m.valid, 0);
        assert_eq!(m.sample(0.0, 0.0), (0.0, 0.0));
    }
}
