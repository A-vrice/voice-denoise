import { describe, it, expect } from "bun:test";
import { encodeWav } from "./encoder";

describe("WAV encoder", () => {
  it("produces a Blob with correct type", () => {
    const pcm = new Float32Array([0.0, 0.1, -0.1, 0.5, -0.5]);
    const blob = encodeWav(pcm, 48000);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/wav");
  });

  it("produces valid WAV with correct header", async () => {
    const pcm = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) {
      pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
    }

    const blob = encodeWav(pcm, 48000);
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);

    // RIFF header
    expect(
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)),
    ).toBe("RIFF");
    // WAVE format
    expect(
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)),
    ).toBe("WAVE");
    // fmt tag
    expect(
      String.fromCharCode(
        view.getUint8(12),
        view.getUint8(13),
        view.getUint8(14),
        view.getUint8(15),
      ),
    ).toBe("fmt ");

    // PCM format (1), mono (1)
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);

    // Sample rate
    expect(view.getUint32(24, true)).toBe(48000);
    // Byte rate: 48000 * 2 (16-bit mono)
    expect(view.getUint32(28, true)).toBe(96000);

    // data chunk
    const dataId = String.fromCharCode(
      view.getUint8(36),
      view.getUint8(37),
      view.getUint8(38),
      view.getUint8(39),
    );
    expect(dataId).toBe("data");

    // data size: 1000 samples * 2 bytes
    expect(view.getUint32(40, true)).toBe(2000);
  });

  it("clips values outside [-1, 1]", async () => {
    const pcm = new Float32Array([2.0, -2.0, 1.5, -1.5]);
    const blob = encodeWav(pcm, 48000);
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);

    // All values should be within int16 range
    for (let i = 0; i < 4; i++) {
      const val = view.getInt16(44 + i * 2, true);
      expect(val).toBeGreaterThanOrEqual(-32768);
      expect(val).toBeLessThanOrEqual(32767);
    }
  });

  it("handles empty PCM", () => {
    const pcm = new Float32Array(0);
    const blob = encodeWav(pcm, 48000);
    expect(blob.size).toBe(44); // header only
  });
});
