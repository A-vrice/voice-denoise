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

export interface RealtimeConfig {
  /** VAD threshold [0.1, 0.9] */
  vadThreshold: number;
  /** Mode: standard (VAD+Gate) or high_quality (VAD+Gate+DFN3) */
  mode: "standard" | "high_quality";
  /** HPF cutoff Hz (0 = disabled) */
  hpfCutoffHz?: number;
  /** Enable automatic level normalization */
  agcEnabled?: boolean;
  /** Enable peak limiter */
  limiterEnabled?: boolean;
}

export class RealtimeProcessor {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private vadEngine: VadEngine | null = null;
  private isActive = false;

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

      // Handle messages from worklet (audio chunks for VAD)
      workletNode.port.onmessage = async (event) => {
        if (event.data.type === "audio" && this.vadEngine) {
          try {
            const samples = new Float32Array(event.data.samples);
            const result = await this.vadEngine.process(samples);
            workletNode.port.postMessage({
              type: "vad",
              probability: result.probability,
            });
          } catch {
            // VAD failed — send default probability
            workletNode.port.postMessage({
              type: "vad",
              probability: 0.5,
            });
          }
        }
      };

      // Send initial params
      workletNode.port.postMessage({
        type: "params",
        params: {
          threshold: config.vadThreshold,
          mode: config.mode,
          hpfCutoffHz: config.hpfCutoffHz ?? 80,
          agcEnabled: config.agcEnabled ?? true,
          limiterEnabled: config.limiterEnabled ?? true,
        },
      });

      // Connect mic -> worklet -> destination
      const source = this.ctx.createMediaStreamSource(this.micStream);
      source.connect(workletNode);
      workletNode.connect(this.ctx.destination);

      this.isActive = true;
    } catch (err) {
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micStream = null;
      this.ctx?.close();
      this.ctx = null;
      throw err;
    }
  }

  stop(): void {
    if (!this.isActive) return;

    // Stop mic tracks
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    // Close audio context
    this.ctx?.close();
    this.ctx = null;

    this.isActive = false;
  }

  get active(): boolean {
    return this.isActive;
  }
}
