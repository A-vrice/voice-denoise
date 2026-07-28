/**
 * High-pass filter — 2nd-order Butterworth biquad (Direct Form I).
 *
 * Removes DC offset and low-frequency rumble (default cutoff 80 Hz).
 * Pure sample-loop implementation: no AudioContext dependency,
 * testable under Node (vitest).
 *
 * worklet-processor.js contains an inlined copy of this logic
 * (AudioWorklet cannot import modules) — keep coefficients in sync.
 */

const DEFAULT_CUTOFF_HZ = 80;
/** Butterworth Q = 1/sqrt(2) */
const Q = 0.7071;

export class HighPassFilter {
  private readonly sampleRate: number;
  private cutoffHz: number;
  // Biquad coefficients (a0 normalized to 1)
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  // DF-I state
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(cutoffHz: number = DEFAULT_CUTOFF_HZ, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.cutoffHz = cutoffHz;
    this.updateCoeffs();
  }

  /** カットオフ周波数の動的変更(係数を再計算) */
  setCutoff(hz: number): void {
    this.cutoffHz = hz;
    this.updateCoeffs();
  }

  /** 内部状態をクリア(新しい入力列の先頭で呼ぶ) */
  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  private updateCoeffs(): void {
    const omega = (2 * Math.PI * this.cutoffHz) / this.sampleRate;
    const sinW = Math.sin(omega);
    const cosW = Math.cos(omega);
    const alpha = sinW / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cosW) / 2 / a0;
    this.b1 = -(1 + cosW) / a0;
    this.b2 = (1 + cosW) / 2 / a0;
    this.a1 = (-2 * cosW) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /**
   * input をフィルタして output に書き出す。
   * 処理長は input/output の短い方に合わせる。
   */
  process(input: Float32Array, output: Float32Array): void {
    const len = Math.min(input.length, output.length);
    const { b0, b1, b2, a1, a2 } = this;
    let { x1, x2, y1, y2 } = this;
    for (let i = 0; i < len; i++) {
      const x = input[i]!;
      let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      if (!Number.isFinite(y)) {
        // NaN/Inf ガード(denormal 暴走・異常入力からの復帰)
        x1 = 0;
        x2 = 0;
        y1 = 0;
        y2 = 0;
        y = 0;
      }
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      output[i] = y;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
  }
}
