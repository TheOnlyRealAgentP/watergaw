#!/usr/bin/env bash
# Rebuild the WebAssembly core into docs/wasm/ and run the decoder tests.
set -euo pipefail
command -v cargo >/dev/null || export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/core"
cargo test --quiet
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/outflow_core.wasm ../docs/wasm/outflow_core.wasm
echo "docs/wasm/outflow_core.wasm: $(wc -c < ../docs/wasm/outflow_core.wasm) bytes"
