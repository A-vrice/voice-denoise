import { describe, it, expect } from "bun:test";
import { downsampleTo16k } from "./vad-engine";

const FS = 48000;

function tone(freq: number, n: number, amp = 0.5): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS);
  return a;
}

/** RMS over a middle slice to avoid FIR edge effects. */
function rmsMid(a: Float32Array): number {
  const lo = a.length >> 3;
  const hi = a.length - lo;
  let s = 0;
  let n = 0;
  for (let i = lo; i < hi; i++) {
    s += a[i]! * a[i]!;
    n++;
  }
  return Math.sqrt(s / n);
}

describe("downsampleTo16k", () => {
  it("produces one output sample per 3 input samples, capped at 512", () => {
    expect(downsampleTo16k(new Float32Array(1536)).length).toBe(512);
    expect(downsampleTo16k(new Float32Array(3072)).length).toBe(512);
    expect(downsampleTo16k(new Float32Array(900)).length).toBe(300);
  });

  it("passes in-band tones with ~unit gain", () => {
    const input = tone(1000, 1536);
    const out = downsampleTo16k(input);
    const ratio = rmsMid(out) / rmsMid(input);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("attenuates out-of-band tones (anti-aliasing)", () => {
    const input = tone(11000, 1536);
    const out = downsampleTo16k(input);
    const ratio = rmsMid(out) / rmsMid(input);
    expect(ratio).toBeLessThan(0.1);
  });
});
