/**
 * Lock-free SPSC (Single Producer, Single Consumer) ring buffer
 * backed by SharedArrayBuffer for AudioWorklet inter-thread communication.
 *
 * Producer: AudioWorklet input handler (writes 128-sample frames)
 * Consumer: VAD/DFN3 processing pipeline (reads 512-sample chunks)
 *
 * Uses Atomics for synchronization — no mutexes, no blocking.
 */

const BUF_SIZE = 4096; // samples, must be power of two
const MASK = BUF_SIZE - 1;

export class RingBuffer {
  private readonly buf: Float32Array;
  private readonly writeIndex: Int32Array;
  private readonly readIndex: Int32Array;

  constructor(sab: SharedArrayBuffer) {
    const byteOffset = 0;
    this.writeIndex = new Int32Array(sab, byteOffset, 1);
    this.readIndex = new Int32Array(sab, 4, 1);
    this.buf = new Float32Array(sab, 8, BUF_SIZE);
  }

  static create(sab: SharedArrayBuffer): RingBuffer {
    return new RingBuffer(sab);
  }

  static getRequiredBufferSize(): number {
    return 8 + BUF_SIZE * 4; // 2 x Int32 + Float32Array
  }

  /** Number of samples available for reading */
  get available(): number {
    return (Atomics.load(this.writeIndex, 0) - Atomics.load(this.readIndex, 0)) & MASK;
  }

  /** Number of slots free for writing */
  get free(): number {
    return BUF_SIZE - 1 - this.available;
  }

  /** Write a single frame (128 samples) from src[offset]. Returns samples written. */
  write(src: Float32Array, offset: number, count: number): number {
    const wi = Atomics.load(this.writeIndex, 0);
    const ri = Atomics.load(this.readIndex, 0);
    const avail = (wi - ri) & MASK;
    const space = BUF_SIZE - 1 - avail;
    const n = Math.min(count, space);
    if (n <= 0) return 0;
    for (let i = 0; i < n; i++) {
      this.buf[(wi + i) & MASK] = src[offset + i]!;
    }
    Atomics.store(this.writeIndex, 0, (wi + n) & MASK);
    return n;
  }

  /** Read up to `count` samples into dst[offset]. Returns samples read. */
  read(dst: Float32Array, offset: number, count: number): number {
    const ri = Atomics.load(this.readIndex, 0);
    const wi = Atomics.load(this.writeIndex, 0);
    const avail = (wi - ri) & MASK;
    const n = Math.min(count, avail);
    if (n <= 0) return 0;

    for (let i = 0; i < n; i++) {
      dst[offset + i] = this.buf[(ri + i) & MASK]!;
    }
    Atomics.store(this.readIndex, 0, (ri + n) & MASK);
    return n;
  }

  /** Reset both indices to zero */
  reset(): void {
    Atomics.store(this.writeIndex, 0, 0);
    Atomics.store(this.readIndex, 0, 0);
  }

  /** Peek at sample offset `pos` from current read position without consuming */
  peek(pos: number): number {
    const ri = Atomics.load(this.readIndex, 0);
    return this.buf[(ri + pos) & MASK]!;
  }

  /** Get raw buffer for direct read access (for WASM memory sharing) */
  getRawBuffer(): Float32Array {
    return this.buf;
  }
}
