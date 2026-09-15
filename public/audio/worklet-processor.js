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
// H-2: HPF/AutoGain/Limiter は src/audio/{hpf,auto-gain,limiter}.ts の
// インライン複製。制約上 unavoidable duplication — 係数・定数を変える際は
// 両側を同期すること。

// DFN glue (src/audio/df.js) is prepended into dist/audio/worklet-processor.js
// by build-static.ts; these helpers resolve to globalThis after the prepend.
/* global initSync, df_create, df_get_frame_length, df_process_frame, df_set_atten_lim */
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
    // DFN3 high-quality state — null until wasm+model arrive via params
    this._dfn = null;
    this._dfnFrameLen = 0;
    // VAD 遅延補償(32ms=1536smpl)と推論用リング — ponytail: SAB は将来対応、現状は TypedArray+transferable で十分
    this._vadDelayBuf = new Float32Array(1536);
    this._vadDelayPos = 0;
    this._vadDelayFilled = 0;
    this._vadBuf = new Float32Array(4096);
    this._vadLen = 0;
    // SAB ring (AudioWorklet -> main VAD) — same layout as src/audio/ring-buffer.ts
    this._sab = null;
    this._sabWriteIdx = null;
    this._sabReadIdx = null;
    this._sabBuf = null;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "sab" && msg.sab instanceof SharedArrayBuffer) {
        try {
          this._sab = msg.sab;
          this._sabWriteIdx = new Int32Array(msg.sab, 0, 1);
          this._sabReadIdx = new Int32Array(msg.sab, 4, 1);
          this._sabBuf = new Float32Array(msg.sab, 8, 4096);
        } catch (e) { console.warn("[worklet] SAB init failed", e); }
        return;
      }
      if (msg.type === "params") {
        const prevCutoff = this._params.hpfCutoffHz;
        Object.assign(this._params, msg.params);
        if (this._params.hpfCutoffHz !== prevCutoff) this._updateHpfCoeffs();
        // First high_quality signal carries compiled wasm + model bytes
        if (msg.params.mode === "high_quality" && this._dfn == null && msg.wasmModule) {
          try {
            // @ts-ignore — globalThis is populated by build-static preamble
            initSync({ module: msg.wasmModule });
            const m = new Uint8Array(msg.modelBytes);
            const h = df_create(m, msg.suppression ?? 100);
            const fl = df_get_frame_length(h);
            this._dfn = h;
            this._dfnFrameLen = fl;
            this._dfnInBuf = new Float32Array(fl * 4);
            this._dfnOutBuf = new Float32Array(fl * 4);
            this._dfnWarmupFrames = 3;
          } catch (e) {
            console.warn("DFN3 worklet init failed:", e);
          }
        }
      }
      if (msg.type === "vad") { this._vadProb = msg.probability; }
      if (msg.type === "suppression" && this._dfn != null) df_set_atten_lim(this._dfn, Math.max(0, Math.min(100, msg.value)));
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

    // 32ms 遅延補償付きゲート: VAD 推論対象窓とゲート適用窓を一致（語頭刈り込み/語尾引きずり対策）
    // 初回 1536 サンプルは遅延が充填されるまで現サンプルでゲート（無音を作らない）
    for (let i = 0; i < len; i++) {
      let src = channel[i];
      if (this._vadDelayFilled >= 1536) {
        src = this._vadDelayBuf[this._vadDelayPos];
        this._vadDelayBuf[this._vadDelayPos] = channel[i];
        this._vadDelayPos = (this._vadDelayPos + 1) % 1536;
      } else {
        this._vadDelayBuf[this._vadDelayPos] = channel[i];
        this._vadDelayPos = (this._vadDelayPos + 1) % 1536;
        this._vadDelayFilled++;
        // 充填前は現サンプルをそのままゲート
      }
      this._smoothedProb = this._smoothedProb * 0.7 + this._vadProb * 0.3;
      const gain = this._computeGateGain(this._smoothedProb);
      outChannel[i] = src * gain;
    }

    if (this._dfn != null) {
      const fl = this._dfnFrameLen;
      // Linear accumulation into a simple window buffer (avoids circular math —
      // only 480 samples per 128-sample quantum, max 4 calls per process tick).
      if (!this._dfnInAccum) this._dfnInAccum = [];
      for (let i = 0; i < len; i++) this._dfnInAccum.push(outChannel[i]);
      if (!this._dfnOutQ) this._dfnOutQ = [];
      while (this._dfnInAccum.length >= fl) {
        const frame = new Float32Array(this._dfnInAccum.splice(0, fl));
        const res = df_process_frame(this._dfn, frame);
        for (let k = 0; k < res.length; k++) this._dfnOutQ.push(res[k]);
      }
      // Warmup: suppress output until 3 DFN frames have been processed (STFT prime)
      // Threshold is fl*3 (DFN frame length 480), not len*3 (quantum 128) — see review C-2.
      const needWarmup = this._dfnOutQ.length < fl * 3;
      if (needWarmup) {
        // leave gate-only output as-is (no overwrite) — graceful warmup
      } else {
        for (let i = 0; i < len; i++) outChannel[i] = this._dfnOutQ.shift();
      }
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

    // VAD 推論用転送: SAB があれば lock-free ring に書き、なければ Float32Array + Transferable にフォールバック
    if (this._sabBuf && this._sabWriteIdx && this._sabReadIdx) {
      // SAB path — SPSC, mask 4095
      for (let i = 0; i < len; i++) {
        const wi = Atomics.load(this._sabWriteIdx, 0);
        const ri = Atomics.load(this._sabReadIdx, 0);
        const avail = (wi - ri) & 4095;
        const free = 4095 - avail;
        if (free <= 0) break; // drop oldest if full (avoid stall)
        this._sabBuf[wi & 4095] = channel[i];
        Atomics.store(this._sabWriteIdx, 0, (wi + 1) & 4095);
      }
      const avail = (Atomics.load(this._sabWriteIdx, 0) - Atomics.load(this._sabReadIdx, 0)) & 4095;
      if (avail >= 1536) {
        this.port.postMessage({ type: "audio", sab: true });
      }
    } else {
      for (let i = 0; i < len; i++) {
        if (this._vadLen >= this._vadBuf.length) {
          const nb = new Float32Array(this._vadBuf.length * 2);
          nb.set(this._vadBuf.subarray(0, this._vadLen));
          this._vadBuf = nb;
        }
        this._vadBuf[this._vadLen++] = channel[i];
      }
      while (this._vadLen >= 1536) {
        const chunk = new Float32Array(1536);
        chunk.set(this._vadBuf.subarray(0, 1536));
        this._vadBuf.copyWithin(0, 1536, this._vadLen);
        this._vadLen -= 1536;
        this.port.postMessage({ type: "audio", samples: chunk }, [chunk.buffer]);
      }
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
