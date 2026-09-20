/**
 * DFN3 engine — loads df_bg.wasm and exposes a frame-based offline processor
 * for FilePipeline.
 *
 * Provenance (see SPEC.md §4.3):
 *   - df_bg.wasm is a build of the upstream DeepFilterNet `libDF` crate
 *     (`--features wasm`) with tract-onnx 0.23.3 and wasm-bindgen 0.2.126, SIMD
 *     enabled. It is NOT the wasm-opt'd artifact distributed by
 *     mezonai/mezon-noise-suppression (that one is ~9.6MB; this build is ~16.4MB
 *     with no wasm-opt pass). See SPEC.md §4.5 for pinned hashes.
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
import { yieldToEventLoop } from "./event-loop";

export interface Dfn3Engine {
  /**
   * Process PCM; resolves to a denoised copy.
   * Yields to the event loop every `YIELD_INTERVAL_FRAMES` DFN frames and
   * rejects with AbortError when `signal` aborts, so a long file can be
   * cancelled mid-pass (this is why it is async: without the yields, a Worker
   * could never read an incoming cancel message).
   */
  process(
    input: Float32Array,
    suppressionPercent: number,
    signal?: AbortSignal,
  ): Promise<Float32Array>;
  reset(): void;
  destroy(): void;
  readonly frameLength: number;
}

/** atten_lim: maximum attenuation in dB. 100 = effectively unlimited. */
const DEFAULT_ATTEN_LIM_DB = 100;

/**
 * Algorithmic look-ahead of this build's deep-filter path, in DFN frames.
 * Measured: the output is delayed by 3 frames (1440 samples @48kHz) whenever
 * attenuation is active. Compensated by pad+trim in process().
 */
const DELAY_FRAMES = 3;

/** DFN frames between event-loop yields (~96ms of audio at 480 samples/frame). */
const YIELD_INTERVAL_FRAMES = 200;

let enginePromise: Promise<Dfn3Engine | null> | null = null;

/**
 * Build a DFN3 engine from raw wasm + model bytes. Throws on failure.
 * Used by `getDfn3Engine()` (fetch) and by offline tooling/tests.
 */
export function createDfn3EngineFromBytes(
  wasmBytes: BufferSource,
  modelBytes: Uint8Array,
): Dfn3Engine {
  initSync({ module: new WebAssembly.Module(wasmBytes) });

  let handle = df_create(modelBytes, DEFAULT_ATTEN_LIM_DB);
  if (!handle) throw new Error("df_create failed");

  const frameLength = df_get_frame_length(handle);

  return {
    frameLength,

    async process(
      input: Float32Array,
      suppressionPercent: number,
      signal?: AbortSignal,
    ): Promise<Float32Array> {
      const atten = Math.max(0, Math.min(100, suppressionPercent));
      // atten_lim=0 bypasses the model entirely (no reduction, and no delay).
      if (atten <= 0) return new Float32Array(input);
      df_set_atten_lim(handle, atten);

      // The deep-filter path delays the output by `delay` samples. Compensate by
      // appending `delay` zeros so the model can emit the tail, then dropping the
      // first `delay` output samples — keeping the output time-aligned.
      const delay = frameLength * DELAY_FRAMES;
      const padded = new Float32Array(input.length + delay);
      padded.set(input, 0);

      const proc = new Float32Array(padded.length);
      const frame = new Float32Array(frameLength);
      let sinceYield = 0;
      for (let pos = 0; pos + frameLength <= padded.length; pos += frameLength) {
        if (++sinceYield >= YIELD_INTERVAL_FRAMES) {
          sinceYield = 0;
          // Must yield inside the loop: the wasm call below is synchronous, so
          // this is the only point where an abort/cancel can be observed.
          await yieldToEventLoop();
          signal?.throwIfAborted();
        }
        frame.set(padded.subarray(pos, pos + frameLength));
        proc.set(df_process_frame(handle, frame), pos);
      }
      const tail = padded.length % frameLength;
      if (tail !== 0) {
        const pos = padded.length - tail;
        frame.fill(0);
        frame.set(padded.subarray(pos));
        proc.set(df_process_frame(handle, frame).subarray(0, tail), pos);
      }

      const out = new Float32Array(input.length);
      out.set(proc.subarray(delay, delay + input.length));

      // Warm-up: the model's state starts cold, so crossfade the pre-DFN signal
      // into the (now time-aligned) output over the delay window.
      const warmup = Math.min(delay, input.length);
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
}

async function create(): Promise<Dfn3Engine | null> {
  try {
    const [wasmResp, modelResp] = await Promise.all([
      fetch("/wasm/df_bg.wasm"),
      fetch("/models/DeepFilterNet3_onnx.tar.gz"),
    ]);
    if (!wasmResp.ok || !modelResp.ok) throw new Error("DFN3 assets fetch failed");

    const wasmBytes = await wasmResp.arrayBuffer();
    const modelBytes = new Uint8Array(await modelResp.arrayBuffer());
    return createDfn3EngineFromBytes(wasmBytes, modelBytes);
  } catch (err) {
    console.warn("DFN3 engine not available:", err);
    // 失敗を握り潰さず再試行できるようにする（VAD 側 app.ts と同じ扱い）。
    // 一時的なネットワーク瞬断でセッション中ずっと高品質が使えなくなるのを防ぐ。
    enginePromise = null;
    return null;
  }
}

/**
 * Lazy singleton. Returns null when assets are missing (fallback to standard);
 * a failed load is not cached, so the next call retries.
 */
export function getDfn3Engine(): Promise<Dfn3Engine | null> {
  if (!enginePromise) enginePromise = create();
  return enginePromise;
}
