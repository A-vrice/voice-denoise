/**
 * Auto Gain — RMS-based level normalization.
 *
 * Measures RMS per window (default 50 ms), computes a gain toward
 * the target level, smooths it with attack/release time constants,
 * and ramps the gain linearly within each window (no zipper noise).
 *
 * Pure sample-loop implementation: no AudioContext dependency,
 * testable under Node (vitest).
 *
 * worklet-processor.js contains an inlined simplified copy — keep
 * constants (targetRms 0.177, window 50ms, attack 10ms, release
 * 200ms, maxGain 4.0) in sync.
 */

export interface AutoGainOptions {
  /** 目標 RMS(デフォルト 0.177 ≒ -15dBFS、音声向け) */
  targetRms: number;
  /** RMS 測定窓(デフォルト 50ms) */
  windowMs: number;
  /** ゲイン低下時の時定数(デフォルト 10ms) */
  attackMs: number;
  /** ゲイン上昇時の時定数(デフォルト 200ms) */
  releaseMs: number;
  /** ゲイン上限(デフォルト 4.0 = 12dB。無音区間の過剰ブースト防止) */
  maxGain: number;
}

const DEFAULT_OPTIONS: AutoGainOptions = {
  targetRms: 0.177,
  windowMs: 50,
  attackMs: 10,
  releaseMs: 200,
  maxGain: 4.0,
};

export class AutoGain {
  private readonly opts: AutoGainOptions;
  private readonly windowSamples: number;
  /** 窓単位の指数平滑係数(attack/release) */
  private readonly attackAlpha: number;
  private readonly releaseAlpha: number;
  /** これ以下の RMS はノイズフロアとみなす(targetRms/10) */
  private readonly noiseFloor: number;
  /** 現在のゲイン(窓境界での値) */
  private gain = 1.0;

  constructor(sampleRate: number, options: Partial<AutoGainOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.windowSamples = Math.max(1, Math.round((this.opts.windowMs / 1000) * sampleRate));
    // 1窓あたりの指数移動係数: alpha = exp(-windowSamples / (sr * tau))
    this.attackAlpha = Math.exp(-this.windowSamples / (sampleRate * (this.opts.attackMs / 1000)));
    this.releaseAlpha = Math.exp(-this.windowSamples / (sampleRate * (this.opts.releaseMs / 1000)));
    this.noiseFloor = this.opts.targetRms / 10;
  }

  reset(): void {
    this.gain = 1.0;
  }

  /**
   * input に自動ゲインを掛けて output に書き出す。
   * 処理長は input/output の短い方に合わせる。
   */
  process(input: Float32Array, output: Float32Array): void {
    const len = Math.min(input.length, output.length);
    const { targetRms, maxGain } = this.opts;
    let pos = 0;
    while (pos < len) {
      const wEnd = Math.min(pos + this.windowSamples, len);
      const wLen = wEnd - pos;

      // 1. 窓の RMS を計算
      let sum = 0;
      for (let i = pos; i < wEnd; i++) {
        const s = input[i]!;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / wLen);

      // 2. 目標ゲイン(ノイズフロアでゼロ除算防止、maxGain でクランプ)
      let target = targetRms / Math.max(rms, this.noiseFloor);
      target = Math.min(maxGain, Math.max(1 / maxGain, target));

      // 3. attack/release で窓単位に指数平滑
      const alpha = target < this.gain ? this.attackAlpha : this.releaseAlpha;
      const endGain = alpha * this.gain + (1 - alpha) * target;

      // 4. 窓内は線形補間(前の窓の最終ゲイン → この窓の目標ゲイン)
      const step = (endGain - this.gain) / wLen;
      let g = this.gain;
      for (let i = pos; i < wEnd; i++) {
        g += step;
        output[i] = input[i]! * g;
      }

      this.gain = endGain;
      pos = wEnd;
    }
  }
}
