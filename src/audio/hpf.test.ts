import { describe, it, expect } from "bun:test";
import { HighPassFilter } from "./hpf";

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

describe("HighPassFilter", () => {
  it("removes DC offset (constant input converges toward zero)", () => {
    const hpf = new HighPassFilter(80, SR);
    const input = new Float32Array(SR).fill(1); // 1秒の DC
    const output = new Float32Array(SR);
    hpf.process(input, output);

    // 最後の 1000 サンプルの絶対値は微小に収束しているはず
    let maxAbs = 0;
    for (let i = output.length - 1000; i < output.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(output[i]!));
    }
    expect(maxAbs).toBeLessThan(1e-3);
  });

  it("attenuates low-frequency content below the cutoff", () => {
    const hpf = new HighPassFilter(80, SR);
    const input = sine(1.0, 20, SR); // 20Hz = cutoff の1/4
    const output = new Float32Array(SR);
    hpf.process(input, output);

    // 2次 Butterworth で 2オクターブ下 → 約 -24dB ≈ 1/16
    // 入力 RMS ≈ 0.707 → 出力 RMS ≈ 0.044。ゆるく < 0.1
    const outRms = rms(output, Math.floor(SR / 2));
    expect(outRms).toBeLessThan(0.1);
    expect(outRms).toBeLessThan(0.707 * 0.2);
  });

  it("passes high-frequency content near unity gain", () => {
    const hpf = new HighPassFilter(80, SR);
    const input = sine(0.5, 1000, SR); // 1kHz ≫ cutoff
    const output = new Float32Array(SR);
    hpf.process(input, output);

    const inRms = rms(input, Math.floor(SR / 2));
    const outRms = rms(output, Math.floor(SR / 2));
    // 通過域: 利得 ≈ 1 (5% 以内)
    expect(outRms).toBeGreaterThan(inRms * 0.95);
    expect(outRms).toBeLessThan(inRms * 1.05);
  });

  it("setCutoff changes the response", () => {
    const hpf = new HighPassFilter(80, SR);
    const input = sine(1.0, 120, SR); // 120Hz
    const out80 = new Float32Array(SR);
    hpf.process(input, out80);

    hpf.reset();
    hpf.setCutoff(200);
    const out200 = new Float32Array(SR);
    hpf.process(input, out200);

    // 200Hz カットオフの方が 120Hz をより減衰させる
    expect(rms(out200, Math.floor(SR / 2))).toBeLessThan(rms(out80, Math.floor(SR / 2)));
  });

  it("reset clears internal state (no lingering transient)", () => {
    const hpf = new HighPassFilter(80, SR);
    const burst = new Float32Array(1000).fill(1);
    const out = new Float32Array(1000);
    hpf.process(burst, out);

    hpf.reset();
    const zeros = new Float32Array(1000);
    hpf.process(zeros, out);
    // リセット直後はゼロ入力でゼロ出力(過渡残存なし)
    expect(Math.abs(out[0]!)).toBeLessThan(1e-9);
  });
});
