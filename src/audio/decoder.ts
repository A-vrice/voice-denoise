/**
 * Audio decoder: loads audio files via Web Audio API,
 * resamples to 48kHz, returns raw PCM Float32Array.
 */

export interface AudioFile {
  readonly name: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly length: number; // total samples per channel
  readonly duration: number; // seconds
  /** Interleaved PCM data, normalized to [-1, 1] */
  readonly data: Float32Array;
}

/**
 * Decode an audio file blob to 48kHz mono PCM.
 */
export async function decodeAudioFile(blob: Blob): Promise<AudioFile> {
  const arrayBuffer = await blob.arrayBuffer();

  // Decode with Web Audio API (supports WAV, MP3, OGG, FLAC, M4A)
  const ctx = new AudioContext({ sampleRate: 48000 });
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close();
  }

  const pcm = mixToMono(audioBuffer);

  return {
    name: "name" in blob ? (blob as File).name : "audio",
    sampleRate: 48000,
    channels: 1, // mono output
    length: pcm.length,
    duration: pcm.length / 48000,
    data: pcm,
  };
}

/**
 * Mix multi-channel AudioBuffer to mono by averaging.
 */
function mixToMono(buf: AudioBuffer): Float32Array {
  const len = buf.length;
  const chans = buf.numberOfChannels;
  const out = new Float32Array(len);

  if (chans === 1) {
    out.set(buf.getChannelData(0));
    return out;
  }

  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < chans; c++) {
      sum += buf.getChannelData(c)[i]!;
    }
    out[i] = sum / chans;
  }
  return out;
}
