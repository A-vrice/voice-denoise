/**
 * Post-EQ: high-shelf boost (biquad) to compensate DFN3 low-pass tendency.
 *
 * Pure JS (no OfflineAudioContext) so it works in main thread *and* Worker.
 * Coefficients follow RBJ Audio EQ Cookbook (highshelf, Q≈0.707).
 */

/**
 * Apply a high-shelf boost. Returns a new Float32Array (or `pcm` when gain==0
 * via resolved promise for callsite compatibility). Default +2dB @8kHz.
 */
export function applyPostEq(
  pcm: Float32Array,
  sampleRate: number,
  gainDb = 2.0,
  freq = 8000,
  q = 0.7,
): Promise<Float32Array> {
  if (gainDb === 0) return Promise.resolve(pcm);
  const out = new Float32Array(pcm.length);
  applyPostEqSync(pcm, out, sampleRate, gainDb, freq, q);
  return Promise.resolve(out);
}

/** Sync variant — zero alloc beyond `out` (caller provides). */
export function applyPostEqSync(
  input: Float32Array,
  output: Float32Array,
  sampleRate: number,
  gainDb = 2.0,
  freq = 8000,
  q = 0.7,
): void {
  const len = Math.min(input.length, output.length);
  // RBJ highshelf: A = 10^(gainDb/40), w0=2pi*f0/Fs, alpha=sin(w0)/(2*Q)
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);
  const sqrtA = Math.sqrt(A);
  // RBJ EQ Cookbook — HighShelf
  const b0 = A * (A + 1 + (A - 1) * cosW0 + 2 * sqrtA * alpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
  const b2 = A * (A + 1 + (A - 1) * cosW0 - 2 * sqrtA * alpha);
  const a0 = A + 1 - (A - 1) * cosW0 + 2 * sqrtA * alpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosW0);
  const a2 = A + 1 - (A - 1) * cosW0 - 2 * sqrtA * alpha;
  // Normalize by a0
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < len; i++) {
    const x = input[i]!;
    let y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    if (!Number.isFinite(y)) { x1 = x2 = y1 = y2 = 0; y = 0; }
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    output[i] = y;
  }
}
