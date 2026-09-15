/**
 * Silero VAD engine — ONNX Runtime Web backend.
 *
 * Accepts 1536 samples @48kHz (32ms), downsamples to 512 @16kHz
 * for VAD inference. Uses non-JSEP WASM to reduce binary size.
 */

// Dynamic import: code-split large ORT bundle. Static type import for annotations.
import type { InferenceSession } from "onnxruntime-web";

export interface VadResult {
  probability: number;
}

export interface VadEngine {
  process(samples: Float32Array): Promise<VadResult>;
  reset(): void;
  destroy(): void;
}

/** Decimation factor 48kHz → 16kHz. */
const DECIM = 3;
/** FIR length (odd => integer center tap, needed for a symmetric linear-phase FIR). */
const TAPS = 49;
/** Anti-alias cutoff (< new Nyquist 8kHz). */
const CUTOFF_HZ = 7000;
const FS = 48000;

/**
 * Windowed-sinc (Blackman) low-pass, DC-normalized to 1.
 * Built once at module load.
 */
function designLowpass(taps: number, cutoffHz: number, fs: number): Float32Array {
  const h = new Float32Array(taps);
  const fc = cutoffHz / fs; // cycles/sample
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    const v = sinc * w;
    h[i] = v;
    sum += v;
  }
  for (let i = 0; i < taps; i++) h[i] = h[i]! / sum;
  return h;
}

const LP = designLowpass(TAPS, CUTOFF_HZ, FS);
const LP_HALF = (TAPS - 1) / 2;

/**
 * 48kHz → 16kHz: linear-phase FIR low-pass (anti-alias) then 3:1 decimation.
 * Output length = min(input.length / 3, 512). Edge samples are zero-padded.
 */
export function downsampleTo16k(src: Float32Array): Float32Array {
  const dstLen = Math.min(Math.floor(src.length / DECIM), 512);
  const dst = new Float32Array(dstLen);
  for (let n = 0; n < dstLen; n++) {
    const center = n * DECIM;
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const idx = center + k - LP_HALF;
      if (idx >= 0 && idx < src.length) acc += LP[k]! * src[idx]!;
    }
    dst[n] = acc;
  }
  return dst;
}

export async function createVadEngine(modelUrl: string | ArrayBuffer): Promise<VadEngine> {
  const ort = await import("./ort-import");

  ort.env.wasm.wasmPaths = {
    wasm: "/wasm/ort-wasm-simd-threaded.wasm",
    mjs: "/wasm/ort-wasm-simd-threaded.mjs",
  };
  ort.env.wasm.simd = true;

  // ORT's overload is too narrow for string|ArrayBuffer; widen via unknown
  const session: InferenceSession = (await (
    ort.InferenceSession.create as unknown as (
      uri: string | ArrayBuffer,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>
  )(modelUrl, { executionProviders: ["wasm"], enableMemoryPattern: false })) as InferenceSession;

  const state = new Float32Array(2 * 1 * 128);

  return {
    async process(samples: Float32Array): Promise<VadResult> {
      const frame16k = downsampleTo16k(samples);

      const results = await session.run({
        input: new ort.Tensor("float32", frame16k, [1, frame16k.length]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(16000)]), [1]),
        state: new ort.Tensor("float32", state, [2, 1, 128]),
      });

      // Validate tensor names and state shape
      const output = results.output as { data: Float32Array } | undefined;
      const stateN = results.stateN as { data: Float32Array } | undefined;
      if (!output?.data) {
        throw new Error("VAD: output tensor 'output' missing — check ONNX model export");
      }
      if (!stateN?.data || stateN.data.length !== 256) {
        throw new Error("VAD: state tensor 'stateN' missing or wrong size (expected 256)");
      }
      const prob = output.data;
      const newState = stateN.data;
      state.set(newState);

      return { probability: prob?.[0] ?? 0.5 };
    },

    reset() {
      state.fill(0);
    },

    destroy() {
      session.release();
    },
  };
}
