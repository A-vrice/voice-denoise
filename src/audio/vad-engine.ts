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

function downsampleTo16k(src: Float32Array): Float32Array {
  const dstLen = Math.min(Math.floor(src.length / 3), 512);
  const dst = new Float32Array(dstLen);
  // 1次 IIR ローパス(fc ≈ 7kHz @48kHz)で折り返しを抑えてから 3:1 間引き
  // alpha = exp(-2*PI*7000/48000) ≈ 0.40
  const alpha = 0.4;
  let prev = 0;
  let out = 0;
  for (let i = 0; i < src.length && out < dstLen; i++) {
    prev = alpha * prev + (1 - alpha) * (src[i] ?? 0);
    if (i % 3 === 2) {
      dst[out] = prev;
      out++;
    }
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
