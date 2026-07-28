/**
 * WAV encoder: PCM Float32Array → WAV Blob.
 * Writes 48kHz 16-bit mono WAV.
 */

const WAV_HEADER_SIZE = 44;

export function encodeWav(pcm: Float32Array, sampleRate: number = 48000): Blob {
  const numSamples = pcm.length;
  const byteLength = numSamples * 2; // 16-bit
  const buf = new ArrayBuffer(WAV_HEADER_SIZE + byteLength);
  const view = new DataView(buf);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + byteLength, true);
  writeString(8, "WAVE");

  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, 1, true); // mono = 1
  view.setUint32(24, sampleRate, true); // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(36, "data");
  view.setUint32(40, byteLength, true);

  // PCM data (Float32 → Int16)
  let offset = WAV_HEADER_SIZE;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, val, true);
    offset += 2;
  }

  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Download a Blob as a file via <a> click.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
