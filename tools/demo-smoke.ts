#!/usr/bin/env bun
/**
 * Smoke: load demo-input.wav via decoder path (manual WAV parse) + run
 * FilePipeline (VAD+Gate+HPF) without ORT (no model) to ensure pipeline
 * and encoder produce valid output. Measures basic metrics.
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { FilePipeline } from "../src/audio/pipeline";
import { encodeWav } from "../src/audio/encoder";

function readWavMono(path: string): { pcm: Float32Array; sr: number } {
  const buf = readFileSync(path);
  // minimal RIFF parse: assumes PCM mono 16-bit
  const sr = buf.readUInt32LE(24);
  const off = 44;
  const n = (buf.length - off) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(off + i * 2) / 32768;
  return { pcm, sr };
}

const inPath = "demo-input.wav";
const { pcm, sr } = readWavMono(inPath);
console.log(`input: ${pcm.length} samples @${sr}Hz (${(pcm.length / sr).toFixed(2)}s)`);

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
console.log(`input RMS: ${rms(pcm).toFixed(4)} peak ${Math.max(...pcm).toFixed(3)}`);

const pipe = new FilePipeline({ mode: "standard", vadThreshold: 0.5, hpfCutoffHz: 80 });
const { pcm: out, blob } = await pipe.processPCM(pcm, sr);
console.log(`output: ${out.length} samples RMS ${rms(out).toFixed(4)} peak ${Math.max(...out).toFixed(3)}`);
console.log(`blob: ${blob.size} bytes type ${blob.type}`);
const outArr = Buffer.from(await blob.arrayBuffer());
writeFileSync("demo-output.wav", outArr);
console.log(`wrote demo-output.wav ${statSync("demo-output.wav").size} bytes`);
console.log("SMOKE PASS");
