/**
 * DFN3 engine — loads df_bg.wasm and exposes a frame-based offline processor
 * for FilePipeline.
 *
 * Provenance (see goal.md §4.3):
 *   - df_bg.wasm is a build of the upstream DeepFilterNet `libDF` crate
 *     (`--features wasm`) with tract-onnx 0.23.3 and wasm-bindgen 0.2.126, SIMD
 *     enabled. It is NOT the wasm-opt'd artifact distributed by
 *     mezonai/mezon-noise-suppression (that one is ~9.6MB; this build is ~16.4MB
 *     with no wasm-opt pass). See goal.md §4.5 for pinned hashes.
 *   - df.js is the wasm-bindgen glue from the same build (its import hashes
 *     match df_bg.wasm's imports).
 *   - Model: public/models/DeepFilterNet3_onnx.tar.gz — upstream DeepFilterNet3
 *     (re-packaged; config.ini identical to upstream).
 *   - License: MIT OR Apache-2.0 (follows the DeepFilterNet upstream).
 *
 * wasm exports: df_create(modelBytes, attenLimDb) -> handle,
 * df_get_frame_length(handle) (=480 @48kHz), df_process_frame(handle, f32[frame]),
 * df_set_atten_lim(handle, limDb), df_set_post_filter_beta(handle, beta).
 * atten_lim is the maximum attenuation in dB (0 = no reduction, 100 = no limit).
 */

// @ts-expect-error — untyped wasm-bindgen glue (plain JS; tsconfig has allowJs=false)
import { initSync } from "./df.js";
// ponytail: 同一モジュールからの名前付き import が ts-expect-error 一括のため分割
// @ts-expect-error — see above
import { df_create, df_get_frame_length, df_process_frame, df_set_atten_lim } from "./df.js";

export interface Dfn3Engine {
  /** Process PCM; returns denoised copy. */
  process(input: Float32Array, suppressionPercent: number): Float32Array;
  reset(): void;
  destroy(): void;
  readonly frameLength: number;
}

/** atten_lim: maximum attenuation in dB. 100 = effectively unlimited. */
const DEFAULT_ATTEN_LIM_DB = 100;

let enginePromise: Promise<Dfn3Engine | null> | null = null;

async function create(): Promise<Dfn3Engine | null> {
  try {
    const [wasmResp, modelResp] = await Promise.all([
      fetch("/wasm/df_bg.wasm"),
      fetch("/models/DeepFilterNet3_onnx.tar.gz"),
    ]);
    if (!wasmResp.ok || !modelResp.ok) throw new Error("DFN3 assets fetch failed");

    const wasmBytes = await wasmResp.arrayBuffer();
    const modelBytes = new Uint8Array(await modelResp.arrayBuffer());

    initSync({ module: new WebAssembly.Module(wasmBytes) });

    let handle = df_create(modelBytes, DEFAULT_ATTEN_LIM_DB);
    if (!handle) throw new Error("df_create failed");

    const frameLength = df_get_frame_length(handle);

    return {
      frameLength,

      process(input: Float32Array, suppressionPercent: number): Float32Array {
        df_set_atten_lim(handle, Math.max(0, Math.min(100, suppressionPercent)));
        const out = new Float32Array(input.length);
        const frame = new Float32Array(frameLength);
        let pos = 0;
        while (pos < input.length) {
          const n = Math.min(frameLength, input.length - pos);
          if (n === frameLength) {
            frame.set(input.subarray(pos, pos + frameLength));
          } else {
            frame.fill(0);
            frame.set(input.subarray(pos, pos + n));
          }
          const processed = df_process_frame(handle, frame);
          out.set(processed.subarray(0, n), pos);
          pos += n;
        }

        // Warm-up: the model's STFT/DNN state starts at zero, so the first few
        // frames are unreliable. df_process_frame is time-aligned (measured lag
        // 0), so blend the pre-DFN signal into the output over the warm-up
        // window with an equal-power crossfade. Never pad+trim: the output is
        // not delayed, so shifting it would misalign the signal.
        const warmup = Math.min(frameLength * 3, input.length);
        for (let i = 0; i < warmup; i++) {
          const t = (i + 1) / warmup;
          const gIn = Math.cos((t * Math.PI) / 2);
          const gOut = Math.sin((t * Math.PI) / 2);
          out[i] = input[i]! * gIn + out[i]! * gOut;
        }
        return out;
      },

      reset() {
        // DFN state carries STFT/DNN overlap across calls; recreate it so each
        // new file starts clean instead of inheriting the previous file's tail.
        const next = df_create(modelBytes, DEFAULT_ATTEN_LIM_DB);
        if (next) handle = next;
      },

      destroy() {
        // The numeric handle has no exposed free() (wasm-bindgen only exposes
        // DFState.free via externref), so drop our reference and let the page
        // reclaim it at teardown.
        handle = 0;
      },
    };
  } catch (err) {
    console.warn("DFN3 engine not available:", err);
    return null;
  }
}

/** Lazy singleton. Returns null when assets are missing (fallback to standard). */
export function getDfn3Engine(): Promise<Dfn3Engine | null> {
  if (!enginePromise) enginePromise = create();
  return enginePromise;
}
