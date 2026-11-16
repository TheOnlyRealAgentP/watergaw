<img src="docs/icons/icon.svg" width="96" alt="Watergaw logo: Hurricane Harvey on radar">

# Watergaw

Pro-grade NEXRAD weather radar, free for everyone. No paywall, account, ads or tracking.

*A watergaw is an old Scots word for a faint, broken piece of rainbow seen in the rain,
long taken as a sign that weather is on the way.*

**Live:** https://theonlyrealagentp.github.io/watergaw/

Watergaw draws radar the way professional viewers do: from each radar's own polar
scans, decoded on your device and rendered on the GPU. It doesn't use pre-colored
image tiles. The features that radar apps usually put behind a subscription come
standard.

## Features

Every feature that other radar apps put behind a subscription is free here.

**For everyone (Simple mode, the default)**
- **Search any place** (city, address or ZIP) and **save places** (home, school, family) to check in one tap.
- **What's coming:** a plain-language card for your location or any place, such as "Heavy rain likely
  around 4:35 PM (in about 20 min)", with a next-hour bar chart, active warnings and approaching storms.
- **Future radar:** the next hour of rain, projected from the radar's own scans (shown as a forecast).
- **Alerts** when a warning covers your location or a saved place, or rain is about to start (while the app is open).
- **Forecast & charts** for any place, or any spot you tap: 48-hour temperature, rain and snow, and wind
  charts with alerts shaded in, plus a 7-day outlook (National Weather Service).
- **All radars or one station:** a seamless, animated national mosaic, or one radar's own full-resolution scans.
- **RouteCast:** plan a drive and see the weather you'll meet at each point when you get there
  (NWS hourly forecasts, active warnings and the next-hour radar), drawn on the map by risk.
- **Lightning**, **hurricanes** (NHC cones, tracks, coastal watches/warnings, 7-day outlook), **hail today**,
  **animated wind**, **earthquakes** (USGS), **wildfires** (NIFC), **river levels** and **rain totals**,
  all with friendly labels.

**For weather pros (Pro mode)**
- **Native radar data:** super-resolution reflectivity (0.25 km × 0.5°) and velocity at six Level III
  elevations, plus **every elevation (up to 18) from the full Level II volume**.
- **Storm-relative velocity at full resolution**, computed per pixel on the GPU (storm motion automatic or manual).
- **Dual-pol:** correlation coefficient, ZDR, KDP and hydrometeor classification.
- **Vertical cross-sections:** tap two points to slice through a storm (reflectivity, velocity, ZDR, CC).
- **Hail and rotation tracks** (MRMS MESH and 0–2 km azimuthal shear) over 1, 6 or 24 hours.
- **Derived products:** digital VIL, enhanced echo tops, and 1-hour, 3-hour, 24-hour and storm-total rainfall.
- **Up to four synchronized panels** with a linked crosshair; loops up to 60 frames; **replay any date since 2022**.
- **Smooth or raw gates**, range highlighting, and GR-compatible `.pal` color tables.
- **Inspector:** value, azimuth, range, beam height and width, plus hail and rotation values from MRMS.
- **Storm tracks** with hail, rotation and arrival times. **Warnings** with damage-threat tags, watches,
  mesoscale discussions, the SPC outlook and storm reports.
- **Water:** NWPS river gauges with forecast hydrographs and flood stages, plus MRMS rainfall totals.
- **Aviation:** METAR flight categories, pilot reports (turbulence, icing), SIGMETs, G-AIRMETs,
  center weather advisories, and official FAA charts (VFR sectional and terminal, IFR low and high).
- Installable (PWA), works offline once loaded, shareable links.

## How it works

```
core/        Rust: Level III and Level II decoders, GRIB2/PNG (MRMS), rain nowcast,
             cross-sections, beam geometry, sweep meshes
             -> compiled to docs/wasm/watergaw_core.wasm (~310 KB, no wasm-bindgen)
docs/        the site GitHub Pages serves (no build step besides the .wasm)
  js/app.js            state, panels, timeline, inspector, sheets
  js/radar-layer.js    MapLibre custom WebGL2 layer that draws a sweep
  js/nexrad.js         product catalog, S3 listings, worker pool, frame cache
  js/decode-worker.js  fetches + decodes radar files off the main thread (WASM)
  js/overlays.js       warnings, storms, reports, SPC, gauges, lightning, hurricanes,
                       MRMS tracks, rasters, rings
  js/places.js         place search and plain-language "what's coming" summaries
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

The Level III decoder is tested gate-for-gate against [MetPy](https://unidata.github.io/MetPy/)
on real files for every supported product, the Level II decoder matches MetPy cut for cut, the
GRIB2 reader matches pygrib/eccodes, and the nowcast recovers a known storm motion (`cargo test`).

**Rain nowcast.** Two recent scans go onto a 2 km grid, block matching finds how the rain moved,
and semi-Lagrangian advection carries the latest scan forward in the radar's own polar layout,
so forecasts render and inspect exactly like real scans.

## Building

The site runs as-is from `docs/` (any static server). After changing Rust code:

```
./build.sh      # cargo test, then rebuild docs/wasm/watergaw_core.wasm
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
archive and rebuilds every icon. It contours the storm into Watergaw's reflectivity
colors, tapers the outer rain bands into spiral arms, and magnifies the eye slightly
so it stays visible at launcher-icon sizes.

## Data sources

NEXRAD Level II and III and MRMS: NOAA Open Data Dissemination (AWS, Unidata). Lightning: NOAA
nowCOAST (NLDN/GLD360). Hurricanes: National Hurricane Center. Place search: OpenStreetMap via Photon. Warnings: National
Weather Service API. Watches, mesoscale discussions, storm attributes, storm reports,
national mosaic and MRMS rainfall tiles: Iowa Environmental Mesonet. Outlooks: Storm
Prediction Center. River gauges and forecasts: National Water Prediction Service. Point forecasts:
National Weather Service API. Earthquakes: USGS. Wildfires: NIFC (WFIGS). Aviation: NOAA Aviation
Weather Center. Wind: NOAA GFS through [Watergaw Wind](https://github.com/TheOnlyRealAgentP/watergaw-wind),
our own open-source engine (vendored in `docs/vendor/`; refresh with `tools/sync_wind.sh`). Driving
routes: OSRM (OpenStreetMap). Flight charts: FAA Aeronautical Information Services.
Satellite: NASA GIBS (GOES ABI band 13). Basemap: OpenFreeMap / OpenStreetMap
contributors. Counties: US Census Bureau.

> Watergaw is an independent project, not affiliated with NOAA or the National Weather
> Service. Data can be delayed or missing. Don't rely on it alone for life-safety
> decisions: follow official NWS warnings and local emergency officials.

## License

Copyright © 2026 Harrison Stewart.

Watergaw is free software under the [GNU Affero General Public License v3.0 or later](LICENSE).
You can use, study, share and modify it. If you distribute a modified version, or run one as a
service that other people use over a network, you must release your source code under the same
license. The name "Watergaw" and the logo aren't covered by this license.
