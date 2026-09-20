#!/usr/bin/env bun
/**
 * Smoke: run FilePipeline (VAD+Gate+HPF) without ORT (no model) over
 * demo-input.wav to ensure the pipeline and encoder produce valid output.
 * Measures basic metrics.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilePipeline } from "../src/audio/pipeline";

// Resolve from this file, not cwd, so the script works from any directory.
const TOOLS_DIR = import.meta.dir;
const REPO_ROOT = join(TOOLS_DIR, "..");
/** Scratch output dir (gitignored), shared with the quality harness. */
const OUT_DIR = join(TOOLS_DIR, "quality/out");

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

const inPath = join(REPO_ROOT, "demo-input.wav");
const { pcm, sr } = readWavMono(inPath);
console.log(`input: ${pcm.length} samples @${sr}Hz (${(pcm.length / sr).toFixed(2)}s)`);

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
console.log(`input RMS: ${rms(pcm).toFixed(4)} peak ${Math.max(...pcm).toFixed(3)}`);

const pipe = new FilePipeline({ mode: "standard", vadThreshold: 0.5, hpfCutoffHz: 80 });
const { pcm: out, blob } = await pipe.processPCM(pcm, sr);
console.log(
  `output: ${out.length} samples RMS ${rms(out).toFixed(4)} peak ${Math.max(...out).toFixed(3)}`,
);
console.log(`blob: ${blob.size} bytes type ${blob.type}`);

let ok = out.length === pcm.length && blob.size > 44 && out.every(Number.isFinite);

// Dump next to the other scratch output (tools/quality/out/ is gitignored)
// so listening to the result does not litter the repo root.
if (ok) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "demo-output.wav"), Buffer.from(await blob.arrayBuffer()));
  console.log(`wrote ${join(OUT_DIR, "demo-output.wav")}`);
}

console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
// FilePipeline holds a module-level MessageChannel (event-loop yield), which
// keeps the Bun process alive; exit explicitly like tools/quality/run_chain.ts.
process.exit(ok ? 0 : 1);
