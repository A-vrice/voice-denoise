/**
 * Noise Gate — applies fade-in/fade-out to non-speech regions
 * based on VAD probability.
 *
 * Per spec:
 *   Attack:     5ms  (fade-in)
 *   Release:    50ms (fade-out, configurable 10-200ms)
 *   Hold:       100ms (ignore short silence, configurable 0-500ms)
 *   Threshold:  0.5 (configurable 0.1-0.9)
 *   Crossfade:  equal-power
 */

export interface GateParams {
  /** VAD threshold [0.1, 0.9]; above = speech */
  threshold: number;
  /** Attack time in samples (at 48kHz) */
  attackSamples: number;
  /** Release time in samples (at 48kHz) */
  releaseSamples: number;
  /** Hold time in samples (at 48kHz); silence shorter than this stays open */
  holdSamples: number;
}

export const DEFAULT_GATE_PARAMS: GateParams = {
  threshold: 0.5,
  attackSamples: Math.round(0.005 * 48000), // 5ms
  releaseSamples: Math.round(0.05 * 48000), // 50ms
  holdSamples: Math.round(0.1 * 48000), // 100ms
};

/**
 * Smoothing filter state for VAD probability interpolation.
 * Uses exponential moving average (EMA) per spec "フレームごとに補間".
 */
export class VadSmoother {
  private smoothed = 0.0;
  private readonly alpha: number;

  /** alpha: 0 = no smoothing, 1 = hold forever. Recommend 0.3-0.7 */
  constructor(alpha = 0.5) {
    this.alpha = alpha;
  }

  /** Feed a raw VAD probability, get smoothed result */
  update(raw: number): number {
    this.smoothed = this.alpha * this.smoothed + (1 - this.alpha) * raw;
    return this.smoothed;
  }

  reset(val = 0.0) {
    this.smoothed = val;
  }

  get value(): number {
    return this.smoothed;
  }
}

/**
 * Noise Gate state machine.
 *
 * States: CLOSED → ATTACKING → OPEN → RELEASING (+ HOLD sub-state)
 */
enum GateState {
  Closed,
  Attacking,
  Open,
  Releasing,
  Hold,
}

export class NoiseGate {
  private state: GateState = GateState.Closed;
  private envelope = 0.0; // current gain [0, 1]
  private holdCounter = 0;
  private vadOn = false;
  /** Linear progress for equal-power curve [0,1]; separate from envelope gain */
  private progress = 0.0;

  constructor(private params: GateParams = DEFAULT_GATE_PARAMS) {}

  /** Process one sample with current VAD probability. Returns gain multiplier. */
  process(smoothedProb: number): number {
    const isSpeech = smoothedProb >= this.params.threshold;

    // State transitions
    switch (this.state) {
      case GateState.Closed:
        if (isSpeech) {
          this.state = GateState.Attacking;
          this.vadOn = true;
        }
        break;

      case GateState.Attacking:
        if (!isSpeech) {
          this.state = GateState.Hold;
          this.holdCounter = 0;
          this.vadOn = false;
        } else if (this.envelope >= 1.0) {
          this.state = GateState.Open;
        }
        break;

      case GateState.Open:
        if (!isSpeech) {
          this.state = GateState.Hold;
          this.holdCounter = 0;
          this.vadOn = false;
        }
        break;

      case GateState.Hold:
        if (isSpeech) {
          this.state = GateState.Open;
          this.vadOn = true;
        } else {
          this.holdCounter++;
          if (this.holdCounter >= this.params.holdSamples) {
            this.state = GateState.Releasing;
          }
        }
        break;

      case GateState.Releasing:
        if (isSpeech) {
          this.state = GateState.Attacking;
          this.vadOn = true;
        } else if (this.envelope <= 0.0) {
          this.state = GateState.Closed;
        }
        break;
    }
    // Envelope update (equal-power crossfade)
    switch (this.state) {
      case GateState.Closed:
        this.progress = 0.0;
        this.envelope = 0.0;
        break;

      case GateState.Attacking: {
        // Linear progress → squared gain (equal-power)
        const step = 1.0 / this.params.attackSamples;
        this.progress = Math.min(1.0, this.progress + step);
        this.envelope = this.progress * this.progress;
        break;
      }

      case GateState.Open:
        this.progress = 1.0;
        this.envelope = 1.0;
        break;

      case GateState.Hold:
        this.progress = 1.0; // hold progress at 1
        this.envelope = 1.0;
        break;

      case GateState.Releasing: {
        // Linear progress → squared gain (equal-power fade-out)
        const step = 1.0 / this.params.releaseSamples;
        this.progress = Math.max(0.0, this.progress - step);
        this.envelope = this.progress * this.progress;
        break;
      }
    }

    return this.envelope;
  }

  /** Process a whole buffer of VAD probabilities, in-place gain multiplication */
  processBlock(pcm: Float32Array, probabilities: Float32Array, out: Float32Array): void {
    const len = Math.min(pcm.length, probabilities.length);
    for (let i = 0; i < len; i++) {
      const gain = this.process(probabilities[i]!);
      out[i] = pcm[i]! * gain;
    }
  }

  /** Reset state */
  reset(): void {
    this.state = GateState.Closed;
    this.envelope = 0.0;
    this.holdCounter = 0;
    this.vadOn = false;
  }

  /** Update parameters at runtime */
  setParams(p: Partial<GateParams>): void {
    Object.assign(this.params, p);
  }
}
