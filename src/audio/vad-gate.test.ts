import { describe, it, expect } from "bun:test";
import { NoiseGate, VadSmoother, DEFAULT_GATE_PARAMS } from "./vad-gate";

describe("NoiseGate", () => {
  it("starts closed with zero envelope", () => {
    const gate = new NoiseGate();
    // With probability 0 (no speech), gain should be 0
    const gain = gate.process(0.0);
    expect(gain).toBe(0);
  });

  it("opens when speech is detected above threshold", () => {
    const params = { ...DEFAULT_GATE_PARAMS, attackSamples: 10, holdSamples: 0 };
    const gate = new NoiseGate(params);
    // Feed speech probability above threshold
    let gain = 0;
    for (let i = 0; i < 15; i++) {
      gain = gate.process(0.9);
    }
    // After attack samples, gain should reach 1.0
    expect(gain).toBeCloseTo(1.0, 1);
  });

  it("closes when silence persists past hold time", () => {
    const params = {
      ...DEFAULT_GATE_PARAMS,
      attackSamples: 5,
      releaseSamples: 10,
      holdSamples: 5,
    };
    const gate = new NoiseGate(params);

    // Speak
    for (let i = 0; i < 10; i++) gate.process(0.9);
    expect(gate["envelope"]).toBeCloseTo(1.0, 1);

    // Stop speaking — enters hold
    for (let i = 0; i < 5; i++) gate.process(0.0);
    // Should still be in hold, envelope = 1
    expect(gate["envelope"]).toBe(1.0);

    // Past hold time → releasing
    for (let i = 0; i < 3; i++) gate.process(0.0);
    // Envelope should be decreasing
    expect(gate["envelope"]).toBeLessThan(1.0);

    // Complete release
    for (let i = 0; i < 20; i++) gate.process(0.0);
    expect(gate["envelope"]).toBe(0);
  });

  it("re-opens during release if speech resumes", () => {
    const params = {
      ...DEFAULT_GATE_PARAMS,
      attackSamples: 5,
      releaseSamples: 20,
      holdSamples: 5,
    };
    const gate = new NoiseGate(params);

    for (let i = 0; i < 10; i++) gate.process(0.9);
    for (let i = 0; i < 10; i++) gate.process(0.0); // hold + start release
    const midRelease = gate["envelope"];
    expect(midRelease).toBeLessThan(1.0);

    // Speech resumes
    for (let i = 0; i < 10; i++) gate.process(0.9);
    expect(gate["envelope"]).toBeGreaterThan(midRelease);
  });

  it("worklet parity: gain recovers monotonically from release without dropping to zero", () => {
    // worklet-processor.js と同一の遷移表: release 中に speech 復帰すると
    // progress を保持したまま attack へ遷移し、ゲインは 0 に落ちず単調回復する。
    const params = {
      ...DEFAULT_GATE_PARAMS,
      attackSamples: 10,
      releaseSamples: 40,
      holdSamples: 5,
    };
    const gate = new NoiseGate(params);

    for (let i = 0; i < 20; i++) gate.process(0.9); // open
    for (let i = 0; i < 20; i++) gate.process(0.0); // hold(5) → releasing
    const atResume = gate["envelope"];
    expect(atResume).toBeGreaterThan(0);
    expect(atResume).toBeLessThan(1.0);

    let prev = -1;
    for (let i = 0; i < 15; i++) {
      const g = gate.process(0.9);
      // 0 に落ちない（ポップノイズ回避）かつ単調増加
      expect(g).toBeGreaterThan(0);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(prev).toBeCloseTo(1.0, 1);
  });

  it("processBlock applies gain to PCM", () => {
    const gate = new NoiseGate();
    const pcm = new Float32Array([0.5, -0.3, 0.1, -0.4]);
    const probs = new Float32Array([0.0, 0.0, 0.0, 0.0]);
    const out = new Float32Array(4);

    gate.processBlock(pcm, probs, out);
    expect(Math.abs(out[0]!)).toBeLessThan(1e-10);
    expect(Math.abs(out[1]!)).toBeLessThan(1e-10);
  });
});

describe("VadSmoother", () => {
  it("starts at zero", () => {
    const s = new VadSmoother(0.5);
    expect(s.value).toBe(0);
  });

  it("converges toward input over time", () => {
    const s = new VadSmoother(0.3);
    s.update(1.0);
    s.update(1.0);
    s.update(1.0);
    s.update(1.0);
    s.update(1.0);
    // After 5 updates with alpha=0.3, value should be close to 1.0
    expect(s.value).toBeGreaterThan(0.8);
  });

  it("reset sets to zero", () => {
    const s = new VadSmoother(0.5);
    s.update(1.0);
    expect(s.value).toBeGreaterThan(0);
    s.reset();
    expect(s.value).toBe(0);
  });
});
