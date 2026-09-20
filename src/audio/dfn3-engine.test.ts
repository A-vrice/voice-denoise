import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createDfn3EngineFromBytes } from "./dfn3-engine";

const WASM = "public/wasm/df_bg.wasm";
const MODEL = "public/models/DeepFilterNet3_onnx.tar.gz";
const hasAssets = existsSync(WASM) && existsSync(MODEL);
const suite = hasAssets ? describe : describe.skip;

suite("Dfn3Engine", () => {
  it("keeps output time-aligned with the input at atten>0 and preserves length", async () => {
    const eng = createDfn3EngineFromBytes(readFileSync(WASM), new Uint8Array(readFileSync(MODEL)));
    const fl = eng.frameLength;
    expect(fl).toBe(480);

    const N = fl * 60;
    const IMP = fl * 20;
    const x = new Float32Array(N);
    for (let i = 0; i < fl * 10; i++) {
      const t = i / 48000;
      x[IMP + i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 5);
    }

    const y = await eng.process(x, 100); // max attenuation
    expect(y.length).toBe(N);

    // Best alignment lag by cross-correlation around the burst. Guards the
    // deep-filter look-ahead delay compensation (regression: off-by-lookahead).
    const W = fl * 8;
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -2 * fl; lag <= 2 * fl; lag++) {
      let acc = 0;
      for (let i = 0; i < W; i++) {
        const j = IMP + lag + i;
        if (j >= 0 && j < N) acc += x[IMP + i]! * y[j]!;
      }
      if (acc > best) {
        best = acc;
        bestLag = lag;
      }
    }
    expect(Math.abs(bestLag)).toBeLessThanOrEqual(fl);
    for (let i = 0; i < N; i++) expect(Number.isFinite(y[i]!)).toBe(true);
  }, 30000);

  // 長い入力で途中 abort すると AbortError で止まる（停止ボタンが実際に効く根拠）。
  // 短い入力だと yield 前に完走してしまうため、yield 間隔(200 frame)を跨ぐ長さにする。
  it("rejects with AbortError when aborted mid-pass, instead of running to completion", async () => {
    const eng = createDfn3EngineFromBytes(readFileSync(WASM), new Uint8Array(readFileSync(MODEL)));
    const controller = new AbortController();
    // 200 frame ごとに yield するので 2000 frame なら 10 回の観測点がある。
    const x = new Float32Array(eng.frameLength * 2000);
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / 48000);

    const pending = eng.process(x, 100, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 30000);

  it("resolves normally when the signal is never aborted", async () => {
    const eng = createDfn3EngineFromBytes(readFileSync(WASM), new Uint8Array(readFileSync(MODEL)));
    const x = new Float32Array(eng.frameLength * 400).fill(0.05);
    const y = await eng.process(x, 100, new AbortController().signal);
    expect(y.length).toBe(x.length);
  }, 30000);
});
