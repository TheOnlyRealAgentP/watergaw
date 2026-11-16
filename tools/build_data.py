"""Build the small static data files the app ships with.

    python tools/build_data.py sites      # docs/data/sites.json from api.weather.gov
    python tools/build_data.py counties   # docs/data/counties.geojson from Census

Counties need geopandas and shapely. Both outputs are committed, so this only
needs rerunning when a radar is added or county lines change.
"""
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'data'
UA = {'User-Agent': 'watergaw-radar data build'}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def sites():
    d = json.loads(get('https://api.weather.gov/radar/stations?stationType=WSR-88D'))
    out = []
    for f in d['features']:
        p = f['properties']
        lon, lat = f['geometry']['coordinates'][:2]
        sid = p['id']
        out.append({
            'id': sid,
            # Level III files are keyed by the last three letters (KTLX -> TLX).
            'l3': sid[1:],
            'name': p['name'],
            'lat': round(lat, 4),
            'lon': round(lon, 4),
            'elev_m': p['elevation']['value'],
        })
    out.sort(key=lambda s: s['id'])
    (OUT / 'sites.json').write_text(json.dumps(out, separators=(',', ':')))
    print(len(out), 'sites')


def counties():
    import geopandas as gpd
    from shapely.geometry import mapping
    from shapely.ops import unary_union
    raw = get('https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_20m.zip')
    tmp = Path('/tmp') if not (OUT.parent.parent / 'tmp').exists() else OUT.parent.parent / 'tmp'
    z = zipfile.ZipFile(io.BytesIO(raw))
    folder = tmp / 'cb_county'
    z.extractall(folder)
    g = gpd.read_file(next(folder.glob('*.shp'))).to_crs(4326)
    # One line per shared edge: county outlines merged so no border is drawn twice.
    lines = unary_union(list(g.boundary))
    geom = mapping(lines)

    def rnd(c):
        return [round(c[0], 4), round(c[1], 4)]
    coords = [[rnd(c) for c in part] for part in geom['coordinates']] if geom['type'] == 'MultiLineString' else [[rnd(c) for c in geom['coordinates']]]
    fc = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {}, 'geometry': {'type': 'MultiLineString', 'coordinates': coords}}]}
    (OUT / 'counties.geojson').write_text(json.dumps(fc, separators=(',', ':')))
    print(len(g), 'counties ->', (OUT / 'counties.geojson').stat().st_size // 1024, 'KB')


if __name__ == '__main__':
    {'sites': sites, 'counties': counties}[sys.argv[1]]()
