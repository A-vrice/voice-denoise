/**
 * Pipeline manager — orchestrates file processing mode (Phase 1).
 *
 * Flow:
 *   1. User selects file → decodeAudioFile()
 *   2. PCM data → VAD engine (512-sample chunks, 48kHz)
 *   3. VAD probabilities → Noise Gate (sample-by-sample gain)
 *   4. Gated PCM → (future: DFN3 → Post-EQ)
 *   5. Output PCM → WAV encoder → download
 *
 * For Phase 1, this runs entirely on the main thread.
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
    console.warn("[pipeline] DFN3 は未実装のため、スタンダード品質の結果を返します");
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
/** 何窓ごとにイベントループへ譲るか */
const YIELD_INTERVAL = 16;

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

  updateOptions(opts: Partial<PipelineOptions>): void {
    Object.assign(this.options, opts);
  }

  /**
   * Process a file blob end-to-end.
   * Returns the output Blob (WAV) and the processed PCM data.
   */
  async processFile(
    blob: Blob,
    onEvent?: PipelineEventCallback,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pcm: Float32Array }> {
    const emit = onEvent ?? this.onEvent;
    const opts = this.options;

    // 1. Decode
    emit({ type: "progress", percent: 5, etaMs: 500 });
    const audio = await decodeAudioFile(blob);

    if (opts.mode === "standard") {
      return this.processStandard(audio, emit, signal);
    } else {
      return this.processHighQuality(audio, emit, signal);
    }
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
    } else {
      return this.processHighQuality(audio, emit, signal);
    }
  }

  /**
   * Standard mode: VAD → Gate only.
   */
  private async processStandard(
    audio: AudioFile,
    emit: PipelineEventCallback,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pcm: Float32Array }> {
    const opts = this.options;

    const pcm = audio.data;
    const len = pcm.length;
    const out = new Float32Array(len);
    const VAD_WINDOW = 1536;
    const numWindows = Math.ceil(len / VAD_WINDOW);

    const vad = this.vadEngine;
    if (vad) {
      vad.reset();
      const smoother = new VadSmoother(this.options.smootherAlpha);
      const gate = new NoiseGate({
        threshold: this.options.vadThreshold,
        attackSamples: Math.round(0.005 * audio.sampleRate),
        releaseSamples: Math.round((this.options.releaseMs / 1000) * audio.sampleRate),
        holdSamples: Math.round((this.options.holdMs / 1000) * audio.sampleRate),
      });

      const probabilities = new Float32Array(len);

      // Run VAD on each window
      const t0 = performance.now();
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
        const percent = 5 + Math.round((done / numWindows) * 45);
        emit({ type: "progress", percent, etaMs });
      }

      gate.processBlock(pcm, probabilities, out);
    } else {
      out.set(pcm);
    }

    // --- Post-processing chain (HPF → Auto Gain → Limiter) ---
    let processed: Float32Array = out;
    if (opts.hpfCutoffHz > 0) {
      const hpf = new HighPassFilter(opts.hpfCutoffHz, audio.sampleRate);
      const tmp = new Float32Array(len);
      hpf.process(processed, tmp);
      processed = tmp;
    }
    if (opts.agcEnabled) {
      const agc = new AutoGain(audio.sampleRate);
      const tmp = new Float32Array(len);
      agc.process(processed, tmp);
      processed = tmp;
    }
    if (opts.limiterEnabled) {
      const limiter = new Limiter(audio.sampleRate);
      const tmp = new Float32Array(len);
      limiter.process(processed, tmp);
      processed = tmp;
    }
    if (processed !== out) out.set(processed);

    emit({ type: "progress", percent: 95, etaMs: 200 });
    const blob = encodeWav(out, audio.sampleRate);
    emit({ type: "progress", percent: 100, etaMs: 0 });
    emit({ type: "complete" });

    return { blob, pcm: out };
  }

  /**
   * High quality mode: VAD → Gate → DFN3 → Post-EQ.
   */
  private async processHighQuality(
    audio: AudioFile,
    emit: PipelineEventCallback,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pcm: Float32Array }> {
    const standardResult = await this.processStandard(audio, emit, signal);

    if (!this.dfn3Engine) {
      warnDfn3NotImplemented();
      return standardResult;
    }

    emit({ type: "progress", percent: 50, etaMs: 2000 });

    try {
      const denoised = this.dfn3Engine.process(standardResult.pcm, this.options.suppression ?? 1.0);

      const { applyPostEq } = await import("./post-eq");
      const eqd = await applyPostEq(denoised, audio.sampleRate, 2.0);

      const { encodeWav } = await import("./encoder");
      const blob = encodeWav(eqd, audio.sampleRate);

      emit({ type: "progress", percent: 100, etaMs: 0 });
      emit({ type: "complete" });

      return { blob, pcm: eqd };
    } catch (err) {
      console.warn("DFN3 error, falling back to standard:", err);
      return standardResult;
    }
  }

  destroy(): void {
    this.vadEngine?.destroy();
    this.vadEngine = null;
  }
}
