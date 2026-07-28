/**
 * PCM playback helper — plays mono Float32 PCM through an AudioContext.
 * Only one playback at a time; starting a new one stops the previous.
 */

let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;

export function stopPlayback(): void {
  if (current) {
    const src = current;
    current = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // already stopped
    }
  }
}

/**
 * Play PCM and return a stop function.
 * `onEnded` fires on natural end or when stopped.
 */
export function playPcm(pcm: Float32Array, sampleRate: number, onEnded?: () => void): () => void {
  stopPlayback();
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
  buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = () => {
    // 後続の playPcm に置き換えられた（＝停止扱いの）ソースでは
    // onEnded を呼ばない。新しい再生の状態を巻き戻さないため。
    if (current !== src) return;
    current = null;
    onEnded?.();
  };
  current = src;
  src.start();
  return stopPlayback;
}
