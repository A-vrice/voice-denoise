import { describe, it, expect } from "bun:test";
import { applyPostEqSync } from "./post-eq";

const SR = 48000;

function tone(freq: number, n = SR): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.1 * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

/** RMS over the second half to skip filter start-up. */
function rmsSteady(a: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = a.length >> 1; i < a.length; i++) {
    s += a[i]! * a[i]!;
    n++;
  }
  return Math.sqrt(s / n);
}

describe("Post-EQ (high shelf)", () => {
  it("boosts high frequencies and leaves lows ~unchanged", () => {
    const hi = tone(12000);
    const hiOut = new Float32Array(hi.length);
    applyPostEqSync(hi, hiOut, SR, 2.0, 8000, 0.7);
    expect(rmsSteady(hiOut)).toBeGreaterThan(rmsSteady(hi) * 1.1);

    const lo = tone(200);
    const loOut = new Float32Array(lo.length);
    applyPostEqSync(lo, loOut, SR, 2.0, 8000, 0.7);
    expect(Math.abs(rmsSteady(loOut) - rmsSteady(lo)) / rmsSteady(lo)).toBeLessThan(0.05);
  });

  it("gainDb=0 is a passthrough", () => {
    const x = tone(12000, 1024);
    const y = new Float32Array(x.length);
    applyPostEqSync(x, y, SR, 0, 8000, 0.7);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i]!, 6);
  });
});
