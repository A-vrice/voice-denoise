/**
 * Post-EQ: Biquad filter-based high-frequency boost.
 * Compensates for DeepFilterNet3 "muffled" sound.
 *
 * Uses Web Audio API BiquadFilterNode internally.
 * For file processing, we apply the filter via OfflineAudioContext.
 */

/**
 * Apply a high-shelf boost to compensate DFN3's low-pass tendency.
 *
 * Default: +2dB high-shelf at 8kHz, Q=0.7.
 */
export function applyPostEq(
  pcm: Float32Array,
  sampleRate: number,
  gainDb: number = 2.0,
  freq: number = 8000,
  q: number = 0.7,
): Promise<Float32Array> {
  if (gainDb === 0) return Promise.resolve(pcm);

  const len = pcm.length;
  const ctx = new OfflineAudioContext(1, len, sampleRate);

  // Input buffer
  const buf = ctx.createBuffer(1, len, sampleRate);
  buf.getChannelData(0).set(pcm);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  // High-shelf filter
  const filter = ctx.createBiquadFilter();
  filter.type = "highshelf";
  filter.frequency.value = freq;
  filter.gain.value = gainDb;
  filter.Q.value = q;

  src.connect(filter).connect(ctx.destination);
  src.start(0);

  return ctx.startRendering().then((rendered) => {
    // Copy back the filtered data
    const out = new Float32Array(len);
    out.set(rendered.getChannelData(0));
    return out;
  });
}
