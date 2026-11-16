<img src="docs/icons/icon.svg" width="96" alt="Outflow logo: Hurricane Harvey on radar">

# Outflow

Pro-grade NEXRAD weather radar, free for everyone. No paywall, account, ads or tracking.

**Live:** https://theonlyrealagentp.github.io/outflow/

Outflow draws radar the way professional viewers do: from each radar's own polar
scans, decoded on your device and rendered on the GPU. It doesn't use pre-colored
image tiles. The features that radar apps usually put behind a subscription come
standard.

## Features

- **Native radar data.** Super-resolution reflectivity (0.25 km × 0.5°) and velocity
  at six elevation angles, straight from NEXRAD Level III files.
- **Storm-relative velocity at full resolution**, computed per pixel on the GPU from
  super-res velocity. Storm motion comes automatically from the radar's tracked cells,
  or you can set it by hand.
- **Dual-pol:** correlation coefficient, ZDR, KDP and hydrometeor classification.
- **Derived products:** digital VIL, enhanced echo tops, and dual-pol 1-hour, 3-hour,
  24-hour and storm-total rainfall.
- **Up to four synchronized panels** with a linked crosshair, for example REF, SRV, CC and ZDR.
- **Smooth or raw.** Smoothing interpolates the data values, not the colors, and
  skips gates without data. Raw mode shows every gate.
- **Highlight a range** to hide everything except, say, CC 0.2–0.82 (debris) or 60+ dBZ (hail cores).
- **GR-compatible color tables:** import any `.pal` file used by GRLevelX, Supercell Wx or RadarOmega.
- **Inspector:** value, azimuth, range, beam height and beam width under the cursor or a tap.
- **Storm tracks:** cell IDs, hail size and probability, rotation and TVS, 60-minute
  forecast paths, and an arrival time for your location.
- **Warnings** with damage-threat and detection tags (PDS, tornado emergency), per-type
  toggles, and a banner when you're inside one. Watches, mesoscale discussions, the SPC
  Day 1 outlook and local storm reports are also included.
- **Water:** NWPS river gauges colored by flood status, with a forecast hydrograph and
  flood stages for each gauge, plus MRMS 1-, 24-, 48- and 72-hour rainfall.
- **Context:** national mosaic when zoomed out, GOES infrared satellite, range rings,
  county lines, and dark, light or satellite basemaps.
- **Installable** (PWA) and works offline once loaded. Every view has a shareable URL.

## How it works

```
core/        Rust: Level III decoder, bzip2, beam geometry, sweep meshes
             -> compiled to docs/wasm/outflow_core.wasm (~140 KB, no wasm-bindgen)
docs/        the site GitHub Pages serves (no build step besides the .wasm)
  js/app.js            state, panels, timeline, inspector, sheets
  js/radar-layer.js    MapLibre custom WebGL2 layer that draws a sweep
  js/nexrad.js         product catalog, S3 listings, worker pool, frame cache
  js/decode-worker.js  fetches + decodes radar files off the main thread (WASM)
  js/overlays.js       warnings, storms, reports, SPC, gauges, rasters, rings
  js/palettes.js       color tables in GR .pal format + parser
  js/style.js          radar-tuned basemap styles
  sw.js                offline shell and cached radar files
tools/       data builders (radar sites, counties) and the MetPy reference exporter
```

1. The browser lists the NOAA Open Data bucket `unidata-nexrad-level3` on AWS
   directly. The bucket allows cross-origin requests, so no server is needed.
2. A Web Worker fetches each file, and the Rust core (WebAssembly) decompresses it,
   decodes the radials, and resamples them onto a uniform azimuth grid aligned to the
   radar's own radial boundaries.
3. Each sweep goes to the GPU as an 8-bit texture (gates × radials) plus a 256-entry
   lookup table of physical values. The fragment shader maps every pixel to its
   azimuth and slant range, looks up the value, optionally subtracts storm motion, and
   colors it from the palette. Vertices are placed with the 4/3-earth beam model.
   Matrices are built relative to the radar in float64, so deep zooms don't jitter.

The decoder is tested gate-for-gate against [MetPy](https://unidata.github.io/MetPy/)
on real files for every supported product (`cargo test`).

## Building

The site runs as-is from `docs/` (any static server). After changing Rust code:

```
./build.sh      # cargo test, then rebuild docs/wasm/outflow_core.wasm
```

Needs Rust with the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`). To refresh the reference data after
adding test files, run `python tools/l3_reference.py core/tests/data/*.l3` (needs MetPy).
`python tools/build_data.py sites|counties` rebuilds the radar list and county lines.

## Android

The app is a standard installable PWA, so the quickest path to the Play Store is a
Trusted Web Activity (e.g. with Bubblewrap), which wraps this exact site. For a native
build, `core/` is a plain Rust library (`crate-type` includes `rlib`). It can be called
from Kotlin through JNI/UniFFI, or bundled with the web UI in a Capacitor shell, where
native networking also opens up Level II data without browser limits.

## The logo

The logo is real radar data: Hurricane Harvey making landfall near Rockport, Texas,
as a category 4 storm, from the Corpus Christi radar's (KCRP) lowest-tilt reflectivity
at 03:04 UTC on 26 August 2017. `tools/build_logo.py` fetches that scan from the NOAA
archive and rebuilds every icon. It contours the storm into Outflow's reflectivity
colors, tapers the outer rain bands into spiral arms, and magnifies the eye slightly
so it stays visible at launcher-icon sizes.

## Data sources

NEXRAD Level III: NOAA Open Data Dissemination (AWS, Unidata). Warnings: National
Weather Service API. Watches, mesoscale discussions, storm attributes, storm reports,
national mosaic and MRMS rainfall tiles: Iowa Environmental Mesonet. Outlooks: Storm
Prediction Center. River gauges and forecasts: National Water Prediction Service.
Satellite: NASA GIBS (GOES ABI band 13). Basemap: OpenFreeMap / OpenStreetMap
contributors. Counties: US Census Bureau.

> Outflow is an independent project, not affiliated with NOAA or the National Weather
> Service. Data can be delayed or missing. Don't rely on it alone for life-safety
> decisions: follow official NWS warnings and local emergency officials.

## License

MIT
