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
 * Uses OfflineAudioContext for resampling.
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

  const srcRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const srcLength = audioBuffer.length;

  let pcm: Float32Array;
  let finalSampleRate = srcRate;

  if (srcRate !== 48000) {
    // Resample via OfflineAudioContext
    pcm = await resampleTo48k(audioBuffer);
    finalSampleRate = 48000;
  } else {
    // Already 48kHz — just mix to mono if needed
    pcm = mixToMono(audioBuffer);
  }

  return {
    name: "name" in blob ? (blob as File).name : "audio",
    sampleRate: finalSampleRate,
    channels: 1, // mono output
    length: pcm.length,
    duration: pcm.length / finalSampleRate,
    data: pcm,
  };
}

/**
 * Resample any AudioBuffer to 48kHz mono using OfflineAudioContext.
 */
async function resampleTo48k(src: AudioBuffer): Promise<Float32Array> {
  const srcRate = src.sampleRate;
  const srcLen = src.length;
  const targetLen = Math.round((srcLen / srcRate) * 48000);

  // Create offline context at 48kHz
  const offline = new OfflineAudioContext(1, targetLen, 48000);
  const srcNode = offline.createBufferSource();
  // Downmix to mono by creating a 1-channel buffer
  const mono = offline.createBuffer(1, srcLen, srcRate);
  const monoData = mono.getChannelData(0);

  if (src.numberOfChannels === 1) {
    monoData.set(src.getChannelData(0));
  } else {
    // Average all channels
    const chans = Array.from({ length: src.numberOfChannels }, (_, i) => src.getChannelData(i));
    for (let i = 0; i < srcLen; i++) {
      let sum = 0;
      for (let c = 0; c < chans.length; c++) sum += chans[c]![i]!;
      monoData[i] = sum / chans.length;
    }
  }

  srcNode.buffer = mono;
  srcNode.connect(offline.destination);
  srcNode.start(0);

  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
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
