/**
 * Pipeline manager — orchestrates file processing.
 *
 * Flow (high quality):
 *   1. User selects file → decodeAudioFile()
 *   2. PCM → VAD → Noise Gate
 *   3. Gated PCM → HPF
 *   4. → DeepFilterNet3 → Post-EQ
 *   5. → AutoGain → Limiter
 *   6. Output PCM → WAV encoder → download
 *
 * Standard mode omits step 4 (DFN3 + Post-EQ) and is used as fallback/preview.
 * Runs inside a Worker (pipeline.worker.ts); pipeline-client.ts falls back to
 * the main thread when a Worker is unavailable.
 */

import type { AudioFile } from "./decoder";
import { decodeAudioFile } from "./decoder";
import { encodeWav, downloadBlob } from "./encoder";
import { NoiseGate, VadSmoother } from "./vad-gate";
import type { VadEngine } from "./vad-engine";
import { HighPassFilter } from "./hpf";
import { AutoGain } from "./auto-gain";
import { Limiter } from "./limiter";

export type PipelineEvent =
  | { type: "progress"; percent: number; etaMs: number }
  | { type: "complete" }
  | { type: "error"; message: string };

export type PipelineEventCallback = (ev: PipelineEvent) => void;

export interface PipelineOptions {
  vadThreshold: number;
  releaseMs: number;
  holdMs: number;
  smootherAlpha: number;
  mode: "standard" | "high_quality";
  suppression: number;
  /** HPF カットオフ周波数。0 = HPF 無効 */
  hpfCutoffHz: number;
  agcEnabled: boolean;
  limiterEnabled: boolean;
}
let dfn3Warned = false;
function warnDfn3NotImplemented(): void {
  if (!dfn3Warned) {
    dfn3Warned = true;
    console.warn("[pipeline] DFN3 が利用できないため、スタンダード品質の結果を返します");
  }
}

/**
 * イベントループへの明示的な譲渡。
 * VAD ループは ORT の promise がマイクロタスクで解決し続けると
 * 入力イベント・描画が完了まで飢餓する（停止ボタンが効かない）ため、
 * 定期的にマクロタスク境界を挟む。setTimeout(0) よりクランプのない
 * MessageChannel を使う。
 */
const yieldChannel = new MessageChannel();
yieldChannel.port1.start();
let yieldResolve: (() => void) | null = null;
yieldChannel.port1.onmessage = () => {
  const r = yieldResolve;
  yieldResolve = null;
  r?.();
};
function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  yieldResolve = resolve;
  yieldChannel.port2.postMessage(null);
  return promise;
}
/** 何窓ごとにイベントループへ譲るか
 * long-file の停止ボタン応答のため 4窓(=128ms)ごとに譲歩。DFN3 は WASM 同期で
 * DFN3 区間は依然ブロックする。 */
const YIELD_INTERVAL = 4;

const DEFAULT_OPTIONS: PipelineOptions = {
  vadThreshold: 0.5,
  releaseMs: 50,
  holdMs: 100,
  smootherAlpha: 0.5,
  mode: "standard",
  suppression: 1.0,
  hpfCutoffHz: 80,
  agcEnabled: true,
  limiterEnabled: true,
};

export class FilePipeline {
  private vadEngine: VadEngine | null = null;
  private dfn3Engine: import("./dfn3-engine").Dfn3Engine | null = null;
  private options: PipelineOptions;
  private onEvent: PipelineEventCallback;
  constructor(opts: Partial<PipelineOptions> = {}, onEvent?: PipelineEventCallback) {
    this.options = { ...DEFAULT_OPTIONS, ...opts };
    this.onEvent = onEvent ?? (() => {});
  }

  setVadEngine(engine: VadEngine): void {
    this.vadEngine = engine;
  }

  setDfn3Engine(engine: import("./dfn3-engine").Dfn3Engine | null): void {
    this.dfn3Engine = engine;
  }

  /**
   * Process raw PCM data directly (pre-decoded).
   * Skips decodeAudioFile — useful when UI has already decoded.
   */
  async processPCM(
    pcm: Float32Array,
    sampleRate: number,
    onEvent?: PipelineEventCallback,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pcm: Float32Array }> {
    const emit = onEvent ?? this.onEvent;
    const audio: AudioFile = {
      name: "input",
      sampleRate,
      channels: 1,
      length: pcm.length,
      duration: pcm.length / sampleRate,
      data: pcm,
    };

    if (this.options.mode === "standard") {
      return this.processStandard(audio, emit, signal);
    }
    return this.processHighQuality(audio, emit, signal);
  }

  /**
   * Standard mode: VAD → Gate → HPF → AutoGain → Limiter.
   */
  private async processStandard(
    audio: AudioFile,
    emit: PipelineEventCallback,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pcm: Float32Array }> {
    const gated = await this.runVadGate(audio, emit, signal, [5, 85]);
    let out = this.applyHpf(gated, audio.sampleRate);
    out = this.applyPostChain(out, audio.sampleRate);
    emit({ type: "progress", percent: 95, etaMs: 200 });
    const blob = encodeWav(out, audio.sampleRate);
    emit({ type: "progress", percent: 100, etaMs: 0 });
    emit({ type: "complete" });
    return { blob, pcm: out };
  }

  /**
   * High quality mode: VAD → Gate → HPF → DFN3 → Post-EQ → AutoGain → Limiter.
   * DFN3 is applied before level normalization/protection so the model sees a
   * clean, un-normalized signal; gain and peaks are handled at the end.
   */
  private async processHighQuality(
    audio: AudioFile,
    emit: PipelineEventCallback,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pcm: Float32Array }> {
    const gated = await this.runVadGate(audio, emit, signal, [5, 35]);
    const hpfOut = this.applyHpf(gated, audio.sampleRate);

    if (!this.dfn3Engine) {
      warnDfn3NotImplemented();
      const out = this.applyPostChain(hpfOut, audio.sampleRate);
      emit({ type: "progress", percent: 100, etaMs: 0 });
      emit({ type: "complete" });
      return { blob: encodeWav(out, audio.sampleRate), pcm: out };
    }

    emit({ type: "progress", percent: 45, etaMs: 2000 });
    // Clear DFN state so this file does not inherit the previous file's tail.
    this.dfn3Engine.reset();
    try {
      // options.suppression は 0-1。atten_lim は「最大減衰量 dB」(0=低減なし)。
      let out = this.dfn3Engine.process(hpfOut, (this.options.suppression ?? 1.0) * 100);
      emit({ type: "progress", percent: 80, etaMs: 1000 });
      const { applyPostEq } = await import("./post-eq");
      out = await applyPostEq(out, audio.sampleRate, 2.0);
      out = this.applyPostChain(out, audio.sampleRate);
      emit({ type: "progress", percent: 95, etaMs: 200 });
      const blob = encodeWav(out, audio.sampleRate);
      emit({ type: "progress", percent: 100, etaMs: 0 });
      emit({ type: "complete" });
      return { blob, pcm: out };
    } catch (err) {
      console.warn("DFN3 error, falling back to standard:", err);
      const out = this.applyPostChain(hpfOut, audio.sampleRate);
      emit({ type: "progress", percent: 100, etaMs: 0 });
      emit({ type: "complete" });
      return { blob: encodeWav(out, audio.sampleRate), pcm: out };
    }
  }

  /**
   * Stage: VAD → Noise Gate. Returns a new gated PCM buffer.
   * Emits progress within `progressRange` per VAD window.
   */
  private async runVadGate(
    audio: AudioFile,
    emit: PipelineEventCallback,
    signal: AbortSignal | undefined,
    progressRange: [number, number],
  ): Promise<Float32Array> {
    const pcm = audio.data;
    const len = pcm.length;
    const out = new Float32Array(len);
    const VAD_WINDOW = 1536;
    const numWindows = Math.ceil(len / VAD_WINDOW);
    const vad = this.vadEngine;

    if (!vad) {
      out.set(pcm);
      return out;
    }

    vad.reset();
    const smoother = new VadSmoother(this.options.smootherAlpha);
    const gate = new NoiseGate({
      threshold: this.options.vadThreshold,
      attackSamples: Math.round(0.005 * audio.sampleRate),
      releaseSamples: Math.round((this.options.releaseMs / 1000) * audio.sampleRate),
      holdSamples: Math.round((this.options.holdMs / 1000) * audio.sampleRate),
    });

    const probabilities = new Float32Array(len);
    const t0 = performance.now();
    const [p0, p1] = progressRange;

    for (let w = 0; w < numWindows; w++) {
      signal?.throwIfAborted();
      // 入力イベント・描画を挟めるよう定期的にイベントループへ譲る
      if (w % YIELD_INTERVAL === YIELD_INTERVAL - 1) {
        await yieldToEventLoop();
      }
      const start = w * VAD_WINDOW;
      const end = Math.min(start + VAD_WINDOW, len);
      const windowSamples = pcm.subarray(start, end);
      const vadInput = new Float32Array(VAD_WINDOW);
      vadInput.set(windowSamples);

      try {
        const result = await vad.process(vadInput);
        const smoothed = smoother.update(result.probability);
        for (let i = start; i < end; i++) {
          probabilities[i] = smoothed;
        }
      } catch (err) {
        // VAD error — mark entire window as uncertain
        console.warn("VAD error at window", w, err);
        for (let i = start; i < end; i++) {
          probabilities[i] = 0.5;
        }
      }

      // 毎窓で進捗を emit し、実測ベースで残り時間を推定する
      const elapsed = performance.now() - t0;
      const done = w + 1;
      const etaMs = Math.round((elapsed / done) * (numWindows - done));
      const percent = p0 + Math.round((done / numWindows) * (p1 - p0));
      emit({ type: "progress", percent, etaMs });
    }

    gate.processBlock(pcm, probabilities, out);
    return out;
  }

  /** Stage: High-pass filter (returns a new buffer; passthrough when disabled). */
  private applyHpf(input: Float32Array, sampleRate: number): Float32Array {
    if (this.options.hpfCutoffHz <= 0) return input;
    const hpf = new HighPassFilter(this.options.hpfCutoffHz, sampleRate);
    const out = new Float32Array(input.length);
    hpf.process(input, out);
    return out;
  }

  /** Stage: AutoGain → Limiter (returns a new buffer). */
  private applyPostChain(input: Float32Array, sampleRate: number): Float32Array {
    let out = input;
    if (this.options.agcEnabled) {
      const agc = new AutoGain(sampleRate);
      const tmp = new Float32Array(out.length);
      agc.process(out, tmp);
      out = tmp;
    }
    if (this.options.limiterEnabled) {
      const limiter = new Limiter(sampleRate);
      const tmp = new Float32Array(out.length);
      limiter.process(out, tmp);
      out = tmp;
    }
    return out;
  }
}
