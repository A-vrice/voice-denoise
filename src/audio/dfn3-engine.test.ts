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

  // 実際の停止ボタンと同じ「タイマー起点」で abort する。同期的な
  // controller.abort() では、yield がイベントループを譲らずタイマーを飢餓
  // させていても通ってしまい回帰を検出できない。ここは実時間のタイマーが
  // 必要（fake timer では「yield がタイマーを飢餓させない」ことを検証できない
  // — 検証対象そのものが実時間のタスクソース間の挙動なので例外とする）。
  it("observes a timer-scheduled abort mid-pass", async () => {
    const eng = createDfn3EngineFromBytes(readFileSync(WASM), new Uint8Array(readFileSync(MODEL)));
    const x = new Float32Array(eng.frameLength * 4000);
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / 48000);

    // 完走した場合の所要時間
    const t0 = performance.now();
    await eng.process(x, 100);
    const fullMs = performance.now() - t0;

    // 50ms 後にタイマーで abort → 完走より明確に速く終わるはず
    eng.reset();
    const controller = new AbortController();
    let firedAt = -1;
    const started = performance.now();
    const timer = setTimeout(() => {
      firedAt = performance.now() - started;
      controller.abort();
    }, 50);
    await expect(eng.process(x, 100, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const abortedMs = performance.now() - started;
    clearTimeout(timer);

    // タイマーが実際に発火した（=yield がタイマーのタスクソースを飢餓させない）
    expect(firedAt).toBeGreaterThanOrEqual(0);
    // 完走せず途中で止まった
    expect(abortedMs).toBeLessThan(fullMs);
  }, 60000);

  it("rejects with AbortError when the signal is already aborted", async () => {
    const eng = createDfn3EngineFromBytes(readFileSync(WASM), new Uint8Array(readFileSync(MODEL)));
    const controller = new AbortController();
    controller.abort();
    const x = new Float32Array(eng.frameLength * 2000).fill(0.05);
    await expect(eng.process(x, 100, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  }, 30000);

  it("resolves normally when the signal is never aborted", async () => {
    const eng = createDfn3EngineFromBytes(readFileSync(WASM), new Uint8Array(readFileSync(MODEL)));
    const x = new Float32Array(eng.frameLength * 400).fill(0.05);
    const y = await eng.process(x, 100, new AbortController().signal);
    expect(y.length).toBe(x.length);
  }, 30000);
});

// 失敗したロードがキャッシュされず、次回呼び出しで再試行されることを検証する。
// DFN3 の失敗をセッション中ずっと固定すると、一時的な瞬断から復帰できない。
suite("getDfn3Engine retry", () => {
  it("retries the asset fetch after a failed load instead of caching the failure", async () => {
    const mod = await import("./dfn3-engine");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    // 常に失敗させる。fetch 回数だけを数える（成功は不要）。
    globalThis.fetch = (async () => {
      calls++;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const first = await mod.getDfn3Engine();
      expect(first).toBeNull();
      const afterFirst = calls;
      expect(afterFirst).toBeGreaterThan(0);

      const second = await mod.getDfn3Engine();
      expect(second).toBeNull();
      // 再試行したので fetch が増えている（キャッシュされていれば増えない）
      expect(calls).toBeGreaterThan(afterFirst);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30000);
});
