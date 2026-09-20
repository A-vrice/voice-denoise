#!/usr/bin/env bun
/**
 * Generate the fixed quality fixture set (48kHz mono 16-bit WAV).
 *
 * - clean: bundled CMU ARCTIC 16kHz WAVs (tools/quality/sources/), band-limited
 *   upsampled x3 to 48kHz.
 * - noise: synthetic pink noise (fixed seed) — license-free and reproducible.
 * - mixes each source at several SNRs; writes <name>_snr<NN>_clean.wav and
 *   <name>_snr<NN>_noisy.wav into tools/quality/fixtures/.
 *
 * Run from the repo root:
 *   bun run tools/quality/generate_fixtures.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav } from "../../src/audio/encoder";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "tools/quality/sources");
const OUT_DIR = join(ROOT, "tools/quality/fixtures");

const OUT_SR = 48000;
const SNRS = [10, 0];
const SEED = 0x5eed;
const MAX_SECONDS = 4;
const CLEAN_RMS = 0.1; // -20 dBFS

// --- WAV read (PCM 16-bit, mono output) ------------------------------------
function readWavMono16(path: string): { pcm: Float32Array; sr: number } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not RIFF/WAVE: ${path}`);
  }
  let o = 12;
  let sr = 16000;
  let channels = 1;
  let bits = 16;
  let fmt = 1;
  let dataOff = -1;
  let dataLen = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === "fmt ") {
      fmt = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sr = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOff = body;
      dataLen = size;
    }
    o = body + size + (size & 1);
  }
  if (dataOff < 0) throw new Error(`no data: ${path}`);
  if (fmt !== 1 || bits !== 16) throw new Error(`expected PCM16: fmt=${fmt} bits=${bits} (${path})`);
  const frames = Math.floor(dataLen / 2 / channels);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = buf.readInt16LE(dataOff + i * channels * 2) / 32768;
  return { pcm, sr };
}

// --- band-limited x3 upsampling (windowed-sinc interpolation) --------------
const HALF = 8;
function sinc(u: number): number {
  return u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
}
function blackman(u: number): number {
  const t = (u + HALF) / (2 * HALF);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}
function upsample3(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length * 3);
  for (let m = 0; m < out.length; m++) {
    const t = m / 3;
    const k0 = Math.ceil(t - HALF);
    const k1 = Math.floor(t + HALF);
    let acc = 0;
    let norm = 0;
    for (let k = k0; k <= k1; k++) {
      const g = sinc(t - k) * blackman(t - k);
      if (k >= 0 && k < x.length) acc += x[k]! * g;
      norm += g;
    }
    out[m] = norm > 0 ? acc / norm : 0;
  }
  return out;
}

// --- noise -----------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Paul Kellet's refined pink-noise filter over unit white noise. */
function pinkNoise(n: number, rnd: () => number): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += out[i]! * out[i]!;
  const rms = Math.sqrt(s / n) || 1;
  for (let i = 0; i < n; i++) out[i] = out[i]! / rms;
  return out;
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

async function writeWav(path: string, pcm: Float32Array): Promise<void> {
  const blob = encodeWav(pcm, OUT_SR);
  writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
}

async function main(): Promise<void> {
  const srcs = readdirSync(SRC_DIR).filter((f) => f.endsWith(".wav")).sort();
  if (srcs.length === 0) throw new Error(`no sources in ${SRC_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const rnd = mulberry32(SEED);
  const manifest: Array<Record<string, unknown>> = [];

  for (const src of srcs) {
    const name = src.replace(/\.wav$/, "");
    const { pcm: p16, sr } = readWavMono16(join(SRC_DIR, src));
    let clean = upsample3(p16);
    const maxN = MAX_SECONDS * OUT_SR;
    if (clean.length > maxN) clean = clean.slice(0, maxN);
    // normalize clean to a consistent level
    const g = CLEAN_RMS / (rms(clean) || 1);
    clean = Float32Array.from(clean, (v) => v * g);

    for (const snr of SNRS) {
      const noise = pinkNoise(clean.length, rnd);
      const sigPow = CLEAN_RMS * CLEAN_RMS;
      const gN = Math.sqrt(sigPow / Math.pow(10, snr / 10));
      const noisy = Float32Array.from(clean, (v, i) => v + gN * noise[i]!);
      const base = `${name}_snr${String(snr).padStart(2, "0")}`;
      await writeWav(join(OUT_DIR, `${base}_clean.wav`), clean);
      await writeWav(join(OUT_DIR, `${base}_noisy.wav`), noisy);
      manifest.push({ name: base, source: src, source_sr: sr, snr_db: snr, samples: clean.length });
      console.log(`wrote ${base} ({clean,noisy}.wav) ${clean.length} samples`);
    }
  }

  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify({ seed: SEED, out_sr: OUT_SR, snrs_db: SNRS, clips: manifest }, null, 2) + "\n",
  );
  console.log(`done: ${manifest.length} pair(s) -> ${OUT_DIR}`);
}

await main();
