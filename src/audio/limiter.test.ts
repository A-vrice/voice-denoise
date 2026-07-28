import { describe, it, expect } from "bun:test";
import { Limiter } from "./limiter";

const SR = 48000;

function maxAbs(data: Float32Array, start = 0, end = data.length): number {
  let m = 0;
  for (let i = start; i < end; i++) {
    m = Math.max(m, Math.abs(data[i]!));
  }
  return m;
}

function sine(amp: number, freqHz: number, samples: number, sr = SR): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr);
  }
  return out;
}

describe("Limiter", () => {
  it("limits large peaks above the threshold", () => {
    const limiter = new Limiter(SR);
    const input = sine(1.0, 500, SR); // フルスケール
    const output = new Float32Array(input.length);
    limiter.process(input, output);

    // 閾値 -2dB(0.794)+ ソフトニー 4:1 → 定常ピーク ≈ 0.8455
    // 最後 0.5 秒の最大値は 0.9 未満(リミット動作)
    const peak = maxAbs(output, output.length - SR / 2);
    expect(peak).toBeLessThan(0.9);
    expect(peak).toBeGreaterThan(0.7); // 完全に潰れていない
  });

  it("leaves below-threshold signal unchanged", () => {
    const limiter = new Limiter(SR);
    const input = sine(0.5, 500, SR); // 0.5 < 0.794 → リダクションなし
    const output = new Float32Array(input.length);
    limiter.process(input, output);

    // ゲインは常に 1、平滑化も 1 から始まる → 出力 == 入力
    for (let i = 0; i < output.length; i++) {
      expect(output[i]).toBeCloseTo(input[i]!, 5);
    }
  });

  it("limits sustained peaks and recovers gain after a transient", () => {
    const limiter = new Limiter(SR);
    const input = new Float32Array(SR);
    // 大半は小音、中央に持続的な 1.0 ピークバースト
    for (let i = 0; i < input.length; i++) {
      input[i] = 0.3 * Math.sin((2 * Math.PI * 500 * i) / SR);
    }
    // 4800 サンプル(100ms)の持続ピーク — ルックアヘッドなしでも
    // エンベロープが追従した後はリダクションが効く
    for (let i = 0; i < 4800; i++) input[SR / 2 + i] = 1.0;

    const output = new Float32Array(SR);
    limiter.process(input, output);

    // ピーク区間の後半(エンベロープ追従後)は 0.9 未満に抑えられる
    const peakRegion = SR / 2 + 2400; // バースト開始 + 50ms
    expect(maxAbs(output, peakRegion, peakRegion + 2000)).toBeLessThan(0.9);
    // 事後の小音区間は過剰リダクションから回復している(ゲイン ≈ 1)
    expect(maxAbs(output, SR - 1000)).toBeLessThan(0.35);
  });

  it("reset clears envelope and gain", () => {
    const limiter = new Limiter(SR);
    const loud = sine(1.0, 500, SR);
    const out = new Float32Array(SR);
    limiter.process(loud, out);

    limiter.reset();
    // リセット後、閾値以下入力はゲイン 1 から再スタート
    const small = sine(0.5, 500, 480);
    const out2 = new Float32Array(480);
    limiter.process(small, out2);
    for (let i = 0; i < out2.length; i++) {
      expect(out2[i]).toBeCloseTo(small[i]!, 5);
    }
  });
});
