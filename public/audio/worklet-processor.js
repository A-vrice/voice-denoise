/**
 * VoiceDenoise AudioWorkletProcessor
 *
 * Runs in the AudioWorklet thread. Receives 128-sample frames
 * from the microphone, applies VAD + Noise Gate, and outputs
 * processed audio to the destination.
 *
 * For standard mode (VAD Gate only), processing is done entirely
 * in the worklet. For high-quality mode (DFN3), frames are
 * passed to the main thread for WASM inference.
 *
 * Registered as "voice-denoise-processor".
 */

// AudioWorkletGlobalScope — no module imports available.
// All dependencies must be inlined or loaded via global scope.

class VoiceDenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Ring buffer state
    this._inputBuffer = new Float32Array(0);
    this._outputBuffer = new Float32Array(0);

    // VAD state (simplified for realtime)
    this._vadProb = 0.0;
    this._smoothedProb = 0.0;
    this._gateEnvelope = 0.0;
    this._gateProgress = 0.0;
    this._gateState = "closed"; // closed | attacking | open | hold | releasing
    this._holdCounter = 0;

    // Parameters (updated via message from main thread)
    this._params = {
      threshold: 0.5,
      attackSamples: 240,   // 5ms @48kHz
      releaseSamples: 2400, // 50ms @48kHz
      holdSamples: 4800,    // 100ms @48kHz
      mode: "standard",
      hpfCutoffHz: 80,
      agcEnabled: true,
      limiterEnabled: true,
    };

    // HPF state — mirrors src/audio/hpf.ts (2nd-order Butterworth
    // high-pass biquad, Q=0.7071, DF-I, sampleRate fixed 48000).
    // Keep coefficients/constants in sync with hpf.ts.
    this._hpfX1 = 0;
    this._hpfX2 = 0;
    this._hpfY1 = 0;
    this._hpfY2 = 0;
    this._hpfB0 = 1;
    this._hpfB1 = 0;
    this._hpfB2 = 0;
    this._hpfA1 = 0;
    this._hpfA2 = 0;
    this._updateHpfCoeffs();

    // Auto Gain state — mirrors src/audio/auto-gain.ts
    // (targetRms=0.177, window=50ms=2400 samples @48k,
    // attack=10ms, release=200ms, maxGain=4.0). Keep in sync.
    this._agcGain = 1.0;
    this._agcRmsAcc = 0;
    this._agcWindowCount = 0;
    this._agcWindowSamples = 2400; // 50ms @48kHz
    this._agcTargetRms = 0.177;
    this._agcNoiseFloor = 0.0177; // targetRms / 10
    this._agcMaxGain = 4.0;
    this._agcAttackAlpha = Math.exp(-2400 / (48000 * 0.01));
    this._agcReleaseAlpha = Math.exp(-2400 / (48000 * 0.2));

    // Limiter state — mirrors src/audio/limiter.ts
    // (thresholdDb=-2, attackMs=0.5, releaseMs=30, 4:1 soft knee).
    // Keep in sync.
    this._limiterEnv = 0;
    this._limiterGain = 1.0;
    this._limiterThreshold = Math.pow(10, -2 / 20); // ~0.794
    this._limiterAttackCoef = Math.exp(-1 / (48000 * 0.0005));
    this._limiterReleaseCoef = Math.exp(-1 / (48000 * 0.03));

    // Receive parameter updates from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === "params") {
        const prevCutoff = this._params.hpfCutoffHz;
        Object.assign(this._params, event.data.params);
        if (this._params.hpfCutoffHz !== prevCutoff) {
          this._updateHpfCoeffs();
        }
      }
      if (event.data.type === "vad") {
        // VAD probability from main thread (ONNX inference)
        this._vadProb = event.data.probability;
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: 0.5, minValue: 0.1, maxValue: 0.9 },
    ];
  }

  process(inputs, outputs, _parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) {
      return true; // Keep alive
    }

    const channel = input[0];
    const outChannel = output[0];
    const len = channel.length;

    // Apply Noise Gate in the worklet
    // VAD probability is received asynchronously from main thread;
    // use the last known value with smoothing.
    for (let i = 0; i < len; i++) {
      // Simple EMA smoothing for VAD probability
      this._smoothedProb =
        this._smoothedProb * 0.7 + this._vadProb * 0.3;

      const gain = this._computeGateGain(this._smoothedProb);
      outChannel[i] = channel[i] * gain;
    }

    // --- Post-processing: HPF → Auto Gain → Limiter ---
    // Mirrors src/audio/hpf.ts, auto-gain.ts, limiter.ts — keep in sync.
    const params = this._params;

    // HPF (2nd-order Butterworth biquad, cutoff 80Hz default, Q=0.7071)
    if (params.hpfCutoffHz > 0) {
      let x1 = this._hpfX1, x2 = this._hpfX2, y1 = this._hpfY1, y2 = this._hpfY2;
      const b0 = this._hpfB0, b1 = this._hpfB1, b2 = this._hpfB2;
      const a1 = this._hpfA1, a2 = this._hpfA2;
      for (let i = 0; i < len; i++) {
        const x = outChannel[i];
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (!Number.isFinite(y)) { x1 = x2 = y1 = y2 = 0; y = 0; }
        x2 = x1; x1 = x;
        y2 = y1; y1 = y;
        outChannel[i] = y;
      }
      this._hpfX1 = x1; this._hpfX2 = x2;
      this._hpfY1 = y1; this._hpfY2 = y2;
    }

    // Auto Gain (targetRms=0.177, window=50ms=2400 @48k, attack=10ms/release=200ms, maxGain=4.0)
    if (params.agcEnabled) {
      let rmsAcc = this._agcRmsAcc;
      let wc = this._agcWindowCount;
      const ws = this._agcWindowSamples;
      for (let i = 0; i < len; i++) {
        const s = outChannel[i];
        rmsAcc += s * s;
        wc++;
        outChannel[i] = s * this._agcGain;
        if (wc >= ws) {
          const rms = Math.sqrt(rmsAcc / ws);
          let target = this._agcTargetRms / Math.max(rms, this._agcNoiseFloor);
          target = Math.min(this._agcMaxGain, Math.max(1 / this._agcMaxGain, target));
          const alpha = target < this._agcGain ? this._agcAttackAlpha : this._agcReleaseAlpha;
          this._agcGain = alpha * this._agcGain + (1 - alpha) * target;
          rmsAcc = 0;
          wc = 0;
        }
      }
      this._agcRmsAcc = rmsAcc;
      this._agcWindowCount = wc;
    }

    // Limiter (threshold=-2dB, attack=0.5ms, release=30ms, 4:1 soft knee)
    if (params.limiterEnabled) {
      let env = this._limiterEnv;
      let gain = this._limiterGain;
      const thr = this._limiterThreshold;
      const atk = this._limiterAttackCoef;
      const rel = this._limiterReleaseCoef;
      for (let i = 0; i < len; i++) {
        const absIn = Math.abs(outChannel[i]);
        if (absIn > env) {
          env = atk * env + (1 - atk) * absIn;
        } else {
          env = Math.max(absIn, env * rel);
        }
        let targetGain = 1;
        if (env > thr) {
          const reduced = thr + (env - thr) / 4;
          targetGain = reduced / env;
        }
        if (targetGain < gain) {
          gain = atk * gain + (1 - atk) * targetGain;
        } else {
          gain = rel * gain + (1 - rel) * targetGain;
        }
        let y = outChannel[i] * gain;
        // ルックアヘッドなしの過渡保護(±1 クランプ) — limiter.ts と同期
        if (y > 1) y = 1;
        else if (y < -1) y = -1;
        outChannel[i] = y;
      }
      this._limiterEnv = env;
      this._limiterGain = gain;
    }

    // Send audio data to main thread for VAD inference (every 1536 samples)

    // Accumulate samples in a buffer
    if (!this._accumulator) this._accumulator = [];
    for (let i = 0; i < len; i++) {
      this._accumulator.push(channel[i]);
    }
    if (this._accumulator.length >= 1536) {
      const chunk = this._accumulator.splice(0, 1536);
      this.port.postMessage({
        type: "audio",
        samples: chunk,
      });
    }

    return true; // Keep processor alive
  }

  /**
   * Noise Gate for real-time use.
   * Same state machine as vad-gate.ts (NoiseGate): progress-based
   * equal-power curve, attack does NOT reset progress (no pop on
   * speech return during release). Keep in sync with vad-gate.ts.
   */
  /**
   * Compute biquad HPF coefficients from current params.
   * Mirrors src/audio/hpf.ts (2nd-order Butterworth high-pass, Q=0.7071).
   */
  _updateHpfCoeffs() {
    const cutoff = this._params.hpfCutoffHz;
    if (cutoff <= 0) {
      this._hpfB0 = 1; this._hpfB1 = 0; this._hpfB2 = 0;
      this._hpfA1 = 0; this._hpfA2 = 0;
      return;
    }
    const omega = (2 * Math.PI * cutoff) / 48000;
    const sinW = Math.sin(omega);
    const cosW = Math.cos(omega);
    const Q = 0.7071;
    const alpha = sinW / (2 * Q);
    const a0 = 1 + alpha;
    this._hpfB0 = ((1 + cosW) / 2) / a0;
    this._hpfB1 = -(1 + cosW) / a0;
    this._hpfB2 = ((1 + cosW) / 2) / a0;
    this._hpfA1 = (-2 * cosW) / a0;
    this._hpfA2 = (1 - alpha) / a0;
  }

  _computeGateGain(prob) {
    const isSpeech = prob >= this._params.threshold;

    // State transitions (mirrors NoiseGate.process in vad-gate.ts)
    switch (this._gateState) {
      case "closed":
        if (isSpeech) {
          this._gateState = "attacking";
        }
        break;

      case "attacking":
        if (!isSpeech) {
          this._gateState = "hold";
          this._holdCounter = 0;
        } else if (this._gateEnvelope >= 1.0) {
          this._gateState = "open";
        }
        break;

      case "open":
        if (!isSpeech) {
          this._gateState = "hold";
          this._holdCounter = 0;
        }
        break;

      case "hold":
        if (isSpeech) {
          this._gateState = "open";
        } else {
          this._holdCounter++;
          if (this._holdCounter >= this._params.holdSamples) {
            this._gateState = "releasing";
          }
        }
        break;

      case "releasing":
        if (isSpeech) {
          this._gateState = "attacking";
        } else if (this._gateEnvelope <= 0.0) {
          this._gateState = "closed";
        }
        break;
    }

    // Envelope update — equal-power (progress^2), mirrors vad-gate.ts
    switch (this._gateState) {
      case "closed":
        this._gateProgress = 0.0;
        this._gateEnvelope = 0.0;
        break;

      case "attacking": {
        const step = 1.0 / this._params.attackSamples;
        this._gateProgress = Math.min(1.0, this._gateProgress + step);
        this._gateEnvelope = this._gateProgress * this._gateProgress;
        break;
      }

      case "open":
      case "hold":
        this._gateProgress = 1.0;
        this._gateEnvelope = 1.0;
        break;

      case "releasing": {
        const step = 1.0 / this._params.releaseSamples;
        this._gateProgress = Math.max(0.0, this._gateProgress - step);
        this._gateEnvelope = this._gateProgress * this._gateProgress;
        break;
      }
    }

    return this._gateEnvelope;
  }
}

registerProcessor("voice-denoise-processor", VoiceDenoiseProcessor);
