# Build environment for DeepFilterNet3 → wasm32
#
# This image compiles the real DFN3 wasm module with tract-onnx.
# Requires ~16GB RAM (Docker Desktop: Settings → Resources → Memory 18GB+)
#
# Usage:
#   docker build -t dfn3-builder -f Dockerfile .
#   docker run --rm -v $(pwd)/wasm/deepfilternet/pkg:/out dfn3-builder
#
# Output: /out/dfn3_bg.wasm + /out/dfn3.js

FROM rust:1.74 AS builder

RUN rustup target add wasm32-unknown-unknown
RUN cargo install wasm-pack --version 0.15.0

WORKDIR /build
COPY wasm/deepfilternet/ .

# Build with reduced parallelism to avoid OOM
ENV CARGO_BUILD_JOBS=1
RUN wasm-pack build --target web --release -- --features wasm

FROM scratch AS export
COPY --from=builder /build/pkg/ /
