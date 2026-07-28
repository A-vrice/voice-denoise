/**
 * DFN3 engine — loads dfn3.wasm (C ABI exports) and
 * exposes the inference API for the pipeline.
 */

export interface Dfn3Engine {
  process(input: Float32Array, attenLimit: number): Float32Array;
  reset(): void;
  destroy(): void;
}

interface Dfn3Exports {
  memory: WebAssembly.Memory;
  dfn3_init: (modelPtr: number, modelLen: number, sr: number) => number;
  dfn3_process: (inputPtr: number, outputPtr: number, frames: number, atten: number) => void;
  dfn3_reset: () => void;
}

export async function createDfn3Engine(wasmUrl: string): Promise<Dfn3Engine | null> {
  try {
    const response = await fetch(wasmUrl);
    const wasmBytes = await response.arrayBuffer();

    const result = await WebAssembly.instantiate(wasmBytes, {
      env: {
        memory: new WebAssembly.Memory({ initial: 256, maximum: 256 }),
      },
    });

    const wasm = result.instance.exports as unknown as Dfn3Exports;
    const mem = () => new Float32Array(wasm.memory.buffer);

    // Init with null model (stub — will use built-in passthrough)
    const ok = wasm.dfn3_init(0, 0, 48000);
    if (ok !== 0) throw new Error("dfn3_init failed");

    return {
      process(input: Float32Array, attenLimit: number): Float32Array {
        const frames = input.length;
        const heap = mem();

        // 256 pages × 64KB = 16 MB → Float32Array 換算で最大 4M 要素
        if (frames * 2 > heap.length) {
          throw new Error(
            `DFN3: input too large (${frames} frames, max ${Math.floor(heap.length / 2)})`,
          );
        }

        // Bump allocator: input at offset 0, output immediately after input.
        // total = 2×frames floats; fits ≤4M elements (max 16MB memory with fixed maximum:256).
        // NOTE: when swapping out the stub, switch to per-call malloc/free pairs
        // instead of reusing fixed offsets (see wasm contract for dfn3_process).
        const INPUT_OFFSET = 0;
        const OUTPUT_OFFSET = frames;

        heap.set(input, INPUT_OFFSET);
        wasm.dfn3_process(INPUT_OFFSET, OUTPUT_OFFSET, frames, attenLimit);
        const output = new Float32Array(frames);
        output.set(heap.subarray(OUTPUT_OFFSET, OUTPUT_OFFSET + frames));
        return output;
      },

      reset() {
        wasm.dfn3_reset();
      },

      destroy() {
        // WASM memory will be GC'd
      },
    };
  } catch (err) {
    console.warn("DFN3 engine not available:", err);
    return null;
  }
}
