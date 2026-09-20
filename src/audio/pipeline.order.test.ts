import { describe, it, expect } from "bun:test";
import { FilePipeline } from "./pipeline";
import type { VadEngine } from "./vad-engine";
import type { Dfn3Engine } from "./dfn3-engine";

function vadStub(probability: number): VadEngine {
  return {
    process: () => Promise.resolve({ probability }),
    reset() {},
    destroy() {},
  };
}

function dfnSpy(run: (input: Float32Array) => Float32Array): {
  engine: Dfn3Engine;
  inputs: Float32Array[];
} {
  const inputs: Float32Array[] = [];
  const engine: Dfn3Engine = {
    frameLength: 480,
    process(input) {
      inputs.push(input);
      return Promise.resolve(run(input));
    },
    reset() {},
    destroy() {},
  };
  return { engine, inputs };
}

const rms = (a: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
};

describe("FilePipeline chain order", () => {
  it("standard mode never invokes the DFN3 engine", async () => {
    const pipe = new FilePipeline({ mode: "standard", hpfCutoffHz: 0 });
    pipe.setVadEngine(vadStub(1));
    const spy = dfnSpy((x) => new Float32Array(x));
    pipe.setDfn3Engine(spy.engine);

    await pipe.processPCM(new Float32Array(1536 * 10).fill(0.5), 48000);
    expect(spy.inputs.length).toBe(0);
  });

  it("high_quality feeds DFN3 the un-normalized signal (AGC runs after DFN3)", async () => {
    const pipe = new FilePipeline({
      mode: "high_quality",
      hpfCutoffHz: 0,
      vadThreshold: 0.5,
      suppression: 1,
      agcEnabled: true,
      limiterEnabled: true,
    });
    pipe.setVadEngine(vadStub(1));
    const spy = dfnSpy((x) => new Float32Array(x));
    pipe.setDfn3Engine(spy.engine);

    await pipe.processPCM(new Float32Array(1536 * 20).fill(0.5), 48000);

    expect(spy.inputs.length).toBe(1);
    // ~0.5 (raw level), not the AGC target 0.177 -> AGC has not run yet
    expect(rms(spy.inputs[0]!)).toBeGreaterThan(0.4);
  });

  it("high_quality normalizes after DFN3 (AGC pulls a constant DFN3 output down)", async () => {
    const pipe = new FilePipeline({ mode: "high_quality", hpfCutoffHz: 0, suppression: 1 });
    pipe.setVadEngine(vadStub(1));
    const spy = dfnSpy((x) => {
      const o = new Float32Array(x.length);
      o.fill(0.5);
      return o;
    });
    pipe.setDfn3Engine(spy.engine);

    const { pcm } = await pipe.processPCM(new Float32Array(1536 * 20).fill(0.5), 48000);
    // A constant 0.5 is pulled toward the -15dBFS (~0.177) AGC target
    expect(rms(pcm)).toBeLessThan(0.4);
  });

  it("high_quality falls back to standard when DFN3 is unavailable", async () => {
    const pipe = new FilePipeline({ mode: "high_quality", hpfCutoffHz: 0 });
    pipe.setVadEngine(vadStub(1));
    const input = new Float32Array(1536 * 8).fill(0.2);
    const { pcm } = await pipe.processPCM(input, 48000);
    expect(pcm.length).toBe(input.length);
  });

  it("preserves length in high_quality with DFN3", async () => {
    const pipe = new FilePipeline({ mode: "high_quality", hpfCutoffHz: 0 });
    pipe.setVadEngine(vadStub(1));
    const spy = dfnSpy((x) => new Float32Array(x));
    pipe.setDfn3Engine(spy.engine);
    const input = new Float32Array(1536 * 7 + 111).fill(0.3);
    const { pcm } = await pipe.processPCM(input, 48000);
    expect(pcm.length).toBe(input.length);
  });
});
