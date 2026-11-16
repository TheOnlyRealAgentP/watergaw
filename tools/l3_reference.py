"""Write MetPy's decoding of Level III test files as JSON for the Rust tests.

Usage: python tools/l3_reference.py core/tests/data/*.l3
Needs MetPy (pip install metpy). For every radial it records the start angle,
width, count of valid gates and their sum, plus 300 random single-gate values,
so `cargo test` can check the Rust decoder gate-for-gate without storing
megabytes of reference data.
"""
import json
import random
import sys

import numpy as np
from metpy.io import Level3File

for path in sys.argv[1:]:
    f = Level3File(path)
    pkt = f.sym_block[0][0]
    codes = np.array([list(r) for r in pkt['data']], dtype=np.int64)
    vals = f.map_data(codes)
    if isinstance(vals, tuple):  # echo tops also return a 'topped' mask
        vals = vals[0]
    vals = np.asarray(vals, dtype=float)
    code = f.header.code
    if code in (170, 172, 173, 174, 175):
        vals = vals * 0.01  # Watergaw reports rainfall in inches
    rng = random.Random(42)
    spots = []
    while len(spots) < 300:
        i = rng.randrange(vals.shape[0])
        j = rng.randrange(vals.shape[1])
        v = vals[i, j]
        if np.isfinite(v) or rng.random() < 0.1:
            spots.append([i, j, None if not np.isfinite(v) else float(v)])
    out = {
        'code': code,
        'lat': f.lat, 'lon': f.lon, 'height': f.height,
        'vol_time': f.metadata['vol_time'].timestamp(),
        'elevation': f.metadata.get('el_angle'),
        'nbins': int(codes.shape[1]),
        'radials': [[float(s), round(float(e) - float(s), 3), int(np.isfinite(v).sum()), float(np.nansum(v))]
                    for s, e, v in zip(pkt['start_az'], pkt['end_az'], vals)],
        'spots': spots,
    }
    with open(path + '.ref.json', 'w') as fh:
        json.dump(out, fh)
    print(path, code, vals.shape)
