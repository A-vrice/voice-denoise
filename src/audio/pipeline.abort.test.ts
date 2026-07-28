import { describe, it, expect } from "bun:test";
import { FilePipeline } from "./pipeline";
import type { VadEngine } from "./vad-engine";

/** 呼び出し回数を数える VAD スタブ。タイマーなしで決定的に abort を挟める */
function createCountingVad(onProcess?: (calls: number) => void): VadEngine {
  let calls = 0;
  return {
    process() {
      calls++;
      onProcess?.(calls);
      return Promise.resolve({ probability: 0.9 });
    },
    reset() {},
    destroy() {},
  };
}

describe("FilePipeline abort", () => {
  it("processPCM rejects with AbortError and emits no complete when aborted mid-loop", async () => {
    const pipe = new FilePipeline({ mode: "standard" });
    const controller = new AbortController();
    // 10窓目の VAD 推論中に abort → 次のイテレーション冒頭で AbortError になる
    pipe.setVadEngine(
      createCountingVad((n) => {
        if (n === 10) controller.abort();
      }),
    );

    const pcm = new Float32Array(1536 * 500);
    pcm.fill(0.1);

    const events: string[] = [];
    await expect(
      pipe.processPCM(pcm, 48000, (ev) => events.push(ev.type), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(events).not.toContain("complete");
  });

  it("completes normally when the signal is not aborted", async () => {
    const pipe = new FilePipeline({ mode: "standard" });
    pipe.setVadEngine(createCountingVad());

    const pcm = new Float32Array(1536 * 20);
    pcm.fill(0.1);
    const controller = new AbortController();

    const events: string[] = [];
    const result = await pipe.processPCM(
      pcm,
      48000,
      (ev) => events.push(ev.type),
      controller.signal,
    );
    expect(events).toContain("complete");
    expect(result.pcm.length).toBe(pcm.length);
    expect(result.blob.size).toBeGreaterThan(44);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const pipe = new FilePipeline({ mode: "standard" });
    pipe.setVadEngine(createCountingVad());

    const controller = new AbortController();
    controller.abort();
    await expect(
      pipe.processPCM(new Float32Array(1536 * 4), 48000, undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
