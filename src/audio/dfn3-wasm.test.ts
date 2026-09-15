import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error — untyped wasm-bindgen glue
import { initSync, df_create, df_get_frame_length, df_process_frame } from "./df.js";

const WASM = "public/wasm/df_bg.wasm";
const MODEL = "public/models/DeepFilterNet3_onnx.tar.gz";
const hasAssets = existsSync(WASM) && existsSync(MODEL);
const suite = hasAssets ? describe : describe.skip;

suite("DFN3 wasm", () => {
  it("has frame length 480 and preserves signal timing (time-aligned)", () => {
    initSync({ module: new WebAssembly.Module(readFileSync(WASM)) });
    const model = new Uint8Array(readFileSync(MODEL));
    // atten_lim=0 => no reduction (near passthrough) so alignment is measurable
    const handle = df_create(model, 0);
    const fl = df_get_frame_length(handle);
    expect(fl).toBe(480);

    const N = fl * 60;
    const IMP = fl * 30;
    const input = new Float32Array(N);
    for (let i = 0; i < fl * 8; i++) {
      input[IMP + i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / 48000) * Math.exp(-i / (fl * 2));
    }
    input[IMP] = 1;

    const out = new Float32Array(N);
    const frame = new Float32Array(fl);
    for (let p = 0; p + fl <= N; p += fl) {
      frame.set(input.subarray(p, p + fl));
      const r = df_process_frame(handle, frame);
      out.set(r.subarray(0, fl), p);
    }

    let onset = -1;
    for (let i = 0; i < N; i++) {
      if (Math.abs(out[i]!) > 1e-3) {
        onset = i;
        break;
      }
    }
    // Output onset must match the input onset within one frame (no added delay).
    expect(Math.abs(onset - IMP)).toBeLessThanOrEqual(fl);
    for (let i = 0; i < N; i++) expect(Number.isFinite(out[i]!)).toBe(true);
  }, 30000);
});
