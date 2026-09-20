/**
 * Realtime microphone processing manager.
 *
 * Manages:
 *   - getUserMedia mic access
 *   - AudioContext + AudioWorklet setup
 *   - VAD inference on captured audio
 *   - Communication between worklet thread and main thread
 */

import type { VadEngine } from "./vad-engine";
import { RingBuffer } from "./ring-buffer";

export interface RealtimeConfig {
  /** VAD threshold [0.1, 0.9] */
  vadThreshold: number;
  /** Mode: standard (VAD+Gate) or high_quality (VAD+Gate+DFN3) */
  mode: "standard" | "high_quality";
  /** HPF cutoff Hz (0 = disabled) */
  hpfCutoffHz?: number;
  /** DFN3 suppression 0-100 (high_quality only) */
  suppression?: number;
  /** Enable automatic level normalization */
  agcEnabled?: boolean;
  /** Enable peak limiter */
  limiterEnabled?: boolean;
}

export class RealtimeProcessor {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private vadEngine: VadEngine | null = null;
  private isActive = false;
  private ringBuffer: RingBuffer | null = null;
  private sab: SharedArrayBuffer | null = null;
  // recording of processed output (captured from worklet via MediaStream or tap)
  private recorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recording = false;
  private recordDest: MediaStreamAudioDestinationNode | null = null;

  setVadEngine(engine: VadEngine): void {
    this.vadEngine = engine;
  }

  async start(config: RealtimeConfig): Promise<void> {
    if (this.isActive) return;

    this.vadEngine?.reset();

    try {
      // Get mic access
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
        },
      });

      // Create AudioContext with COOP/COEP support
      this.ctx = new AudioContext({ sampleRate: 48000 });

      // Load AudioWorklet module. The worklet lives at /audio/worklet-processor.js
      // in both dev (Vite serves public/) and prod (copied by build:static).
      // Using an absolute path avoids import.meta.url resolution differences
      // between the bundled and unbundled contexts.
      await this.ctx.audioWorklet.addModule("/audio/worklet-processor.js");

      // Create AudioWorklet node
      const workletNode = new AudioWorkletNode(this.ctx, "voice-denoise-processor");

      // Keep handle for live suppression updates
      this.workletNode = workletNode;

      // SAB path: worklet writes Input to SAB ring; main reads 1536 per VAD frame.
      // Legacy path: worklet posts Float32Array(1536) directly.
      const trySAB = (() => {
        if (!crossOriginIsolated) return null;
        try {
          const sab = new SharedArrayBuffer(RingBuffer.getRequiredBufferSize());
          const rb = RingBuffer.create(sab);
          this.sab = sab;
          this.ringBuffer = rb;
          workletNode.port.postMessage({ type: "sab", sab });
          return rb;
        } catch {
          return null;
        }
      })();

      // Handle messages from worklet (audio chunks for VAD)
      workletNode.port.onmessage = async (event) => {
        if (event.data.type === "audio") {
          let samples: Float32Array;
          if (this.ringBuffer && event.data.sab) {
            // SAB signal: drain 1536 from shared ring
            const rb = this.ringBuffer;
            while (rb.available >= 1536) {
              const frame = new Float32Array(1536);
              rb.read(frame, 0, 1536);
              if (!this.vadEngine) continue;
              try {
                const result = await this.vadEngine.process(frame);
                workletNode.port.postMessage({ type: "vad", probability: result.probability });
              } catch {
                workletNode.port.postMessage({ type: "vad", probability: 0.5 });
              }
            }
            return;
          }
          if (!this.vadEngine) return;
          try {
            samples = new Float32Array(event.data.samples);
            const result = await this.vadEngine.process(samples);
            workletNode.port.postMessage({ type: "vad", probability: result.probability });
          } catch {
            workletNode.port.postMessage({ type: "vad", probability: 0.5 });
          }
        }
      };

      // Send initial params, plus wasm+model when high_quality
      const msg: Record<string, unknown> = {
        type: "params",
        params: {
          threshold: config.vadThreshold,
          mode: config.mode,
          hpfCutoffHz: config.hpfCutoffHz ?? 80,
          agcEnabled: config.agcEnabled ?? true,
          limiterEnabled: config.limiterEnabled ?? true,
        },
      };
      if (config.mode === "high_quality") {
        try {
          const [wasmBuf, modelBuf] = await Promise.all([
            fetch("/wasm/df_bg.wasm").then((r) => r.arrayBuffer()),
            fetch("/models/DeepFilterNet3_onnx.tar.gz").then((r) => r.arrayBuffer()),
          ]);
          msg.wasmModule = await WebAssembly.compile(wasmBuf);
          msg.modelBytes = modelBuf;
          msg.suppression = config.suppression ?? 70;
        } catch {
          // fall through — worklet stays gate-only, no DFN3
        }
      }
      workletNode.port.postMessage(msg);

      // Connect mic -> worklet -> destination (and split to recorder tap)
      const source = this.ctx.createMediaStreamSource(this.micStream);
      source.connect(workletNode);
      workletNode.connect(this.ctx.destination);
      // Tap for MediaRecorder (records processed output, not raw mic)
      this.recordDest = this.ctx.createMediaStreamDestination();
      workletNode.connect(this.recordDest);

      this.isActive = true;
    } catch (err) {
      // H-3: isActive は成功時のみ true にする。失敗時の ctx/mic は確実に解放。
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micStream = null;
      if (this.ctx) {
        try {
          await this.ctx.close();
        } catch {
          /* ignore */
        }
      }
      this.ctx = null;
      throw err;
    }
  }

  setSuppression(value: number): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: "suppression",
        value: Math.max(0, Math.min(100, value)),
      });
    }
  }

  startRecording(): void {
    if (!this.ctx || !this.recordDest || this.recording) return;
    this.recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    try {
      this.recorder = new MediaRecorder(this.recordDest.stream, { mimeType: mime });
    } catch {
      this.recorder = new MediaRecorder(this.recordDest.stream);
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.recorder.start(100);
    this.recording = true;
  }

  stopRecording(): Blob | null {
    if (!this.recorder) return null;
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } catch {}
    this.recording = false;
    const blob = this.recordedChunks.length
      ? new Blob(this.recordedChunks, { type: this.recorder.mimeType || "audio/webm" })
      : null;
    this.recordedChunks = [];
    this.recorder = null;
    return blob;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  async stop(): Promise<void> {
    if (!this.isActive && !this.micStream && !this.ctx) return;

    // Stop mic tracks
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    if (this.recorder && this.recorder.state !== "inactive")
      try {
        this.recorder.stop();
      } catch {}
    this.recorder = null;
    this.recordedChunks = [];
    this.recording = false;
    this.recordDest = null;
    this.ringBuffer = null;
    this.sab = null;
    this.workletNode = null;
    // Close audio context — await to avoid dangling AudioContext
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      try {
        await ctx.close();
      } catch {
        /* already closed */
      }
    }

    this.isActive = false;
  }
}
