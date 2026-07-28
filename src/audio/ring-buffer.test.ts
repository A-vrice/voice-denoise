/**
 * @vitest-environment node
 */
import { describe, it, expect } from "bun:test";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  const SAB = new SharedArrayBuffer(RingBuffer.getRequiredBufferSize());

  it("starts empty", () => {
    const buf = RingBuffer.create(new SharedArrayBuffer(RingBuffer.getRequiredBufferSize()));
    expect(buf.available).toBe(0);
    expect(buf.free).toBeGreaterThan(0);
  });

  it("writes and reads single frame", () => {
    const buf = RingBuffer.create(new SharedArrayBuffer(RingBuffer.getRequiredBufferSize()));
    const src = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);

    const written = buf.write(src, 0, 5);
    expect(written).toBe(5);
    expect(buf.available).toBe(5);

    const dst = new Float32Array(5);
    const read = buf.read(dst, 0, 5);
    expect(read).toBe(5);
    expect(dst[0]).toBeCloseTo(0.1);
    expect(dst[4]).toBeCloseTo(0.5);
  });

  it("wraps around the buffer boundary", () => {
    const buf = RingBuffer.create(new SharedArrayBuffer(RingBuffer.getRequiredBufferSize()));
    // Fill buffer nearly full
    const chunk = new Float32Array(1024).fill(0.5);
    buf.write(chunk, 0, 1024);
    buf.read(new Float32Array(1024), 0, 1024); // drain
    expect(buf.available).toBe(0);

    // Write near the end
    const src = new Float32Array(100).map((_, i) => i / 100);
    buf.write(src, 0, 100);
    expect(buf.available).toBe(100);

    const dst = new Float32Array(100);
    buf.read(dst, 0, 100);
    expect(dst[0]).toBeCloseTo(0);
    expect(dst[99]).toBeCloseTo(0.99);
  });

  it("returns 0 when buffer is full", () => {
    const buf = RingBuffer.create(new SharedArrayBuffer(RingBuffer.getRequiredBufferSize()));
    const big = new Float32Array(4096).fill(1);
    const written = buf.write(big, 0, 4096);
    // Max capacity is 4095 (MASK), so at most 4095
    expect(written).toBeLessThanOrEqual(4095);
    // Next write should return 0
    const second = buf.write(new Float32Array(10), 0, 10);
    expect(second).toBe(0);
  });

  it("reset clears both indices", () => {
    const buf = RingBuffer.create(new SharedArrayBuffer(RingBuffer.getRequiredBufferSize()));
    buf.write(new Float32Array([1, 2, 3]), 0, 3);
    expect(buf.available).toBe(3);
    buf.reset();
    expect(buf.available).toBe(0);
  });

  it("peek reads without consuming", () => {
    const buf = RingBuffer.create(new SharedArrayBuffer(RingBuffer.getRequiredBufferSize()));
    buf.write(new Float32Array([0.7, 0.8, 0.9]), 0, 3);
    expect(buf.peek(0)).toBeCloseTo(0.7);
    expect(buf.peek(2)).toBeCloseTo(0.9);
    expect(buf.available).toBe(3); // Not consumed
  });
});
