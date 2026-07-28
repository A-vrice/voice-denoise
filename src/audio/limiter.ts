/**
 * Limiter — peak-envelope follower with 4:1 soft knee.
 *
 * Simple lookahead-less peak protection for speech: tracks a fast-
 * attack / slow-release envelope, and above the threshold reduces
 * gain so the envelope approaches `threshold + (env - threshold)/4`.
 *
 * Pure sample-loop implementation: no AudioContext dependency,
 * testable under Node (vitest).
 *
 * worklet-processor.js contains an inlined copy — keep constants
 * (threshold -2dB, attack 0.5ms, release 30ms, ratio 4:1) in sync.
 */

export interface LimiterOptions {
  /** リダクション開始閾値(デフォルト -2dBFS) */
  thresholdDb: number;
  /** エンベロープ上昇時定数(デフォルト 0.5ms) */
  attackMs: number;
  /** エンベロープ下降時定数(デフォルト 30ms) */
  releaseMs: number;
}

const DEFAULT_OPTIONS: LimiterOptions = {
  thresholdDb: -2,
  attackMs: 0.5,
  releaseMs: 30,
};

/** ソフトニー比(4:1) */
const KNEE_RATIO = 4;

export class Limiter {
  private readonly thresholdLinear: number;
  private readonly attackCoef: number;
  private readonly releaseCoef: number;
  private env = 0;
  private smoothGain = 1.0;

  constructor(sampleRate: number, options: Partial<LimiterOptions> = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.thresholdLinear = Math.pow(10, opts.thresholdDb / 20);
    this.attackCoef = Math.exp(-1 / (sampleRate * (opts.attackMs / 1000)));
    this.releaseCoef = Math.exp(-1 / (sampleRate * (opts.releaseMs / 1000)));
  }

  reset(): void {
    this.env = 0;
    this.smoothGain = 1.0;
  }

  /**
   * input にリミッタを掛けて output に書き出す。
   * 処理長は input/output の短い方に合わせる。
   */
  process(input: Float32Array, output: Float32Array): void {
    const len = Math.min(input.length, output.length);
    const { thresholdLinear: thr, attackCoef, releaseCoef } = this;
    let env = this.env;
    let g = this.smoothGain;
    for (let i = 0; i < len; i++) {
      const absIn = Math.abs(input[i]!);

      // エンベロープ追従(高速アタック / 低速リリース)
      if (absIn > env) {
        env = attackCoef * env + (1 - attackCoef) * absIn;
      } else {
        env = Math.max(absIn, env * releaseCoef);
      }

      // 4:1 ソフトニーのリダクション量
      let targetGain = 1.0;
      if (env > thr) {
        const reduced = thr + (env - thr) / KNEE_RATIO;
        targetGain = reduced / env;
      }

      // ゲイン平滑化(click 防止): 下がる方向は速く、戻る方向は遅く
      if (targetGain < g) {
        g = attackCoef * g + (1 - attackCoef) * targetGain;
      } else {
        g = releaseCoef * g + (1 - releaseCoef) * targetGain;
      }

      let y = input[i]! * g;
      // ルックアヘッドなしでも過渡が素通りするため、最終保護として ±1 でクランプ。
      // ソフトニー後の残留ピークが WAV 16-bit エンコードでクリップ歪むのを防ぐ。
      if (y > 1) y = 1;
      else if (y < -1) y = -1;
      output[i] = y;
    }
    this.env = env;
    this.smoothGain = g;
  }
}
