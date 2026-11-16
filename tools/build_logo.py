"""Build the Watergaw logo from Hurricane Harvey's landfall radar scan.

The mark is real data: the Corpus Christi radar's (KCRP) lowest-tilt
reflectivity at 03:04 UTC on 26 Aug 2017, as Harvey came ashore near Rockport
as a category 4 hurricane. The scan is gridded around the eye, smoothed, given
a radial fade so the outer rain bands taper into spiral arms, lightly
magnified at the centre so the eye survives at launcher-icon sizes, and
contoured into vector bands in Watergaw's reflectivity colors.

    python tools/build_logo.py

Needs MetPy, SciPy, Matplotlib and Shapely. Writes docs/icons/icon.svg and
maskable.svg, then renders the PNG sizes with Inkscape when it's installed.
"""
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from metpy.io import Level2File
from scipy.ndimage import gaussian_filter, map_coordinates
from shapely.geometry import LineString

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'docs' / 'icons'
SCAN = 'https://unidata-nexrad-level2.s3.amazonaws.com/2017/08/26/KCRP/KCRP20170826_030439_V06'

# Contour bands: dBZ threshold, color, opacity, smoothing (km), smallest kept area (px²).
LEVELS = [(16, '#2a6fd6', 0.6, 4.5, 260), (22, '#2fcf68', 1, 3.6, 200), (30, '#ffd43b', 1, 3.0, 120),
          (36, '#ff8a1e', 1, 2.6, 80), (41, '#ff3434', 1, 2.4, 60), (45, '#e43ad8', 1, 2.2, 40)]
HALF, RES = 120.0, 0.4  # grid half-width and spacing, km


def load_sweep():
    cache = Path(tempfile.gettempdir()) / 'watergaw_KCRP20170826_030439_V06'
    if not cache.exists():
        urllib.request.urlretrieve(SCAN, cache)
    sweep = Level2File(str(cache)).sweeps[0]
    az = np.array([r[0].az_angle for r in sweep])
    ref = np.array([r[4][b'REF'][1] for r in sweep])
    hdr = sweep[0][4][b'REF'][0]
    order = np.argsort(az)
    return az[order], ref[order], hdr.first_gate, hdr.gate_width


def to_grid(az, ref, first, gw, cx, cy, half, res):
    """Nearest-gate Cartesian grid (km east/north of the radar) centred on (cx, cy)."""
    xs = np.arange(cx - half, cx + half, res) + res / 2
    ys = np.arange(cy + half, cy - half, -res) - res / 2
    X, Y = np.meshgrid(xs, ys)
    A = (np.degrees(np.arctan2(X, Y)) + 360) % 360
    i = np.searchsorted(az, A) % len(az)
    prev = (i - 1) % len(az)
    closer = np.abs((A - az[prev] + 180) % 360 - 180) < np.abs((A - az[i] + 180) % 360 - 180)
    i = np.where(closer, prev, i)
    g = np.floor((np.hypot(X, Y) - first) / gw + 0.5).astype(int)
    ok = (g >= 0) & (g < ref.shape[1])
    out = np.zeros(X.shape)
    out[ok] = np.nan_to_num(ref[i[ok], g[ok]], nan=0)
    return out


def find_eye(az, ref, first, gw, guess=(55.0, 25.0)):
    """Centroid of the weak-echo eye near a first guess (km from the radar)."""
    g = to_grid(az, ref, first, gw, *guess, 25, 0.5)
    yy, xx = np.mgrid[0:g.shape[0], 0:g.shape[1]]
    xs = guess[0] - 25 + 0.25 + xx * 0.5
    ys = guess[1] + 25 - 0.25 - yy * 0.5
    m = (gaussian_filter(g, 4) < 28) & (np.hypot(xs - guess[0], ys - guess[1]) < 18)
    return xs[m].mean(), ys[m].mean()


def build(scale=2.2, rx=112, rings_bg=True):
    az, ref, first, gw = load_sweep()
    cx, cy = find_eye(az, ref, first, gw)
    raw = to_grid(az, ref, first, gw, cx, cy, HALF, RES)
    xs = -HALF + RES / 2 + np.arange(raw.shape[0]) * RES
    X, Y = np.meshgrid(xs, -xs)
    R = np.hypot(X, Y)

    def field(sig, clear_eye):
        G = gaussian_filter(raw, sig / RES) - 0.24 * np.maximum(0, R - 28)  # bands taper outward
        if clear_eye:
            G -= 40 * np.clip((22 - R) / 6, 0, 1)
        rs = np.where(R > 0, 100 * (R / 100) ** 1.3, 0)  # mild fisheye on the eye
        f = np.where(R > 0, rs / np.maximum(R, 1e-9), 0)
        return map_coordinates(G, [(HALF - RES / 2 - Y * f) / RES, (X * f + HALF - RES / 2) / RES], order=1, cval=0)

    def rings(G, thr, min_area):
        cs = plt.contourf(xs, -xs, G, levels=[thr, 1e9])
        out = []
        for path in cs.get_paths():
            for poly in path.to_polygons():
                pts = np.column_stack([256 + poly[:, 0] * scale, 256 - poly[:, 1] * scale])
                area = 0.5 * np.sum(pts[:-1, 0] * pts[1:, 1] - pts[1:, 0] * pts[:-1, 1])
                if abs(area) >= min_area:
                    out.append(np.array(LineString(pts).simplify(0.6).coords))
        plt.close('all')
        return ' '.join('M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in r[:-1]) + 'Z' for r in out)

    paths = [(c, o, rings(field(sig, t == 16), t, amin)) for t, c, o, sig, amin in LEVELS]
    ring_svg = ('<g fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="2.5">'
                '<circle cx="256" cy="256" r="226"/><circle cx="256" cy="256" r="150"/></g>') if rings_bg else ''
    glow = f'<path d="{paths[1][2]}" fill="#2fcf68" fill-rule="evenodd" opacity="0.3" filter="url(#glow)"/>'
    body = ''.join(f'<path d="{p}" fill="{c}" fill-rule="evenodd"' + (f' opacity="{o}"' if o < 1 else '') + '/>' for c, o, p in paths)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
            '<title>Watergaw</title>'
            '<!-- Hurricane Harvey at landfall: KCRP 0.5° reflectivity, 2017-08-26 03:04 UTC (tools/build_logo.py) -->'
            '<defs><radialGradient id="bg" cx="30%" cy="20%" r="95%"><stop offset="0" stop-color="#1c2b41"/>'
            '<stop offset="0.55" stop-color="#0e1622"/><stop offset="1" stop-color="#06090e"/></radialGradient>'
            '<filter id="glow" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="16"/></filter></defs>'
            f'<rect width="512" height="512" rx="{rx}" fill="url(#bg)"/>{ring_svg}{glow}{body}</svg>')


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    (ICONS / 'icon.svg').write_text(build())
    # Maskable icons get cropped to a circle: full-bleed background, art inside the safe zone.
    (ICONS / 'maskable.svg').write_text(build(scale=1.72, rx=0, rings_bg=False))
    ink = shutil.which('inkscape')
    if not ink:
        print('Inkscape not found: SVGs written, PNGs not rendered.')
        return
    for src, out, size in [('icon.svg', 'icon-192.png', 192), ('icon.svg', 'icon-512.png', 512), ('maskable.svg', 'maskable-512.png', 512)]:
        subprocess.run([ink, str(ICONS / src), '-w', str(size), '-h', str(size), '-o', str(ICONS / out)], check=True, capture_output=True)
    print('wrote', ', '.join(p.name for p in sorted(ICONS.iterdir())))


if __name__ == '__main__':
    main()
