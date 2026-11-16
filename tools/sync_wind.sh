#!/usr/bin/env bash
# Copy the Watergaw Wind engine (../watergaw-wind) into docs/vendor/.
# Upstream: https://github.com/TheOnlyRealAgentP/watergaw-wind
set -euo pipefail
src="$(dirname "$0")/../../watergaw-wind"
dst="$(dirname "$0")/../docs/vendor/watergaw-wind"
mkdir -p "$dst/js" "$dst/wasm"
cp "$src/js/wind-engine.js" "$src/js/wind-core.js" "$src/js/wind-worker.js" "$src/js/wind-particles.js" "$dst/js/"
cp "$src/wasm/watergaw_wind.wasm" "$dst/wasm/"
cp "$src/LICENSE" "$dst/LICENSE"
echo "synced watergaw-wind $(git -C "$src" rev-parse --short HEAD)"
