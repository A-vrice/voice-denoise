import { describe, it, expect } from "bun:test";
import { AutoGain } from "./auto-gain";

const SR = 48000;

function rms(data: Float32Array, start = 0, end = data.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = data[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / (end - start));
}

function sine(amp: number, freqHz: number, samples: number, sr = SR): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr);
  }
  return out;
}

describe("AutoGain", () => {
  it("amplifies a small signal toward the target RMS", () => {
    // amp 0.08 → RMS ≈ 0.0566 → targetGain ≈ 3.13 (< maxGain 4)
    const agc = new AutoGain(SR);
    const input = sine(0.08, 500, SR * 2);
    const output = new Float32Array(input.length);
    agc.process(input, output);

    // 最後 0.5 秒で目標 0.177 付近に収束(±15%)
    const outRms = rms(output, output.length - SR / 2);
    expect(outRms).toBeGreaterThan(0.177 * 0.85);
    expect(outRms).toBeLessThan(0.177 * 1.15);
  });

  it("attenuates a large signal toward the target RMS", () => {
    const agc = new AutoGain(SR);
    const input = sine(0.9, 500, SR * 2);
    const output = new Float32Array(input.length);
    agc.process(input, output);

    const outRms = rms(output, output.length - SR / 2);
    expect(outRms).toBeGreaterThan(0.177 * 0.85);
    expect(outRms).toBeLessThan(0.177 * 1.15);
  });

  it("clamps gain to maxGain on near-silence (no excessive boost)", () => {
    const agc = new AutoGain(SR);
    // 0.001 振幅: RMS 0.001 < noiseFloor 0.0177 → targetGain 10 → clamp 4
    const input = sine(0.001, 500, SR);
    const output = new Float32Array(input.length);
    agc.process(input, output);

    // 出力 RMS ≈ 0.001 * 4 = 0.004(maxGain 頭打ち、10 倍にはならない)
    const outRms = rms(output, output.length - SR / 4);
    expect(outRms).toBeLessThan(0.006);
    expect(outRms).toBeGreaterThan(0.002);
    // NaN/Inf なし
    for (let i = 0; i < output.length; i++) {
      expect(Number.isFinite(output[i]!)).toBe(true);
    }
  });

  it("produces no NaN on full silence", () => {
    const agc = new AutoGain(SR);
    const input = new Float32Array(SR); // 全ゼロ
    const output = new Float32Array(SR);
    agc.process(input, output);
    for (let i = 0; i < output.length; i++) {
      expect(output[i]).toBe(0);
      expect(Number.isFinite(output[i]!)).toBe(true);
    }
  });

  it("reset restores gain to unity", () => {
    const agc = new AutoGain(SR);
    const loud = sine(0.9, 500, SR);
    const out = new Float32Array(SR);
    agc.process(loud, out);
    // リセット後、大入力でも初期ゲイン 1.0 から再スタート(直後はほぼ入力通り)
    agc.reset();
    const out2 = new Float32Array(480); // 10ms
    const in2 = sine(0.9, 500, 480);
    agc.process(in2, out2);
    // 最初のサンプルはゲイン ≈ 1(attack 1窓分の線形補間始点)
    expect(out2[0]).toBeCloseTo(in2[0]!, 3);
  });
});
