#!/usr/bin/env bun
/**
 * Quality harness (offline, no browser).
 *
 * Runs the DFN3 file-processing chain on each `*_noisy.wav` fixture and writes
 * `*_processed.wav` to tools/quality/out/. Run from the repo root:
 *
 *   bun run tools/quality/run_chain.ts
 *
 * The VAD/noise gate is intentionally NOT applied: the gate removes non-speech
 * by design, which would distort an intrusive metric (PESQ/STOI). This measures
 * the DFN3 chain itself: HPF -> DFN3 -> Post-EQ -> AutoGain -> Limiter.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FilePipeline } from "../../src/audio/pipeline";
import { createDfn3EngineFromBytes } from "../../src/audio/dfn3-engine";
import { encodeWav } from "../../src/audio/encoder";

const ROOT = process.cwd();
const FIX_DIR = process.env.QUALITY_FIXTURES ?? join(ROOT, "tools/quality/fixtures");
const OUT_DIR = process.env.QUALITY_OUT ?? join(ROOT, "tools/quality/out");

interface Wav {
  pcm: Float32Array;
  sr: number;
}

/** Minimal RIFF/WAVE reader (PCM 16-bit mono). */
function readWavMono16(path: string): Wav {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  }
  let o = 12;
  let sr = 48000;
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
  if (dataOff < 0) throw new Error(`no data chunk: ${path}`);
  if (fmt !== 1 || bits !== 16) throw new Error(`expected PCM 16-bit, got fmt=${fmt} bits=${bits}`);

  const frames = Math.floor(dataLen / 2 / channels);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const idx = dataOff + i * channels * 2;
    pcm[i] = buf.readInt16LE(idx) / 32768;
  }
  return { pcm, sr };
}

async function main(): Promise<void> {
  if (!existsSync(FIX_DIR)) throw new Error(`fixtures dir not found: ${FIX_DIR}`);
  console.log(`fixtures: ${FIX_DIR}`);
  const wasmBytes = readFileSync(join(ROOT, "public/wasm/df_bg.wasm"));
  const modelBytes = new Uint8Array(readFileSync(join(ROOT, "public/models/DeepFilterNet3_onnx.tar.gz")));
  console.log("loading DFN3 engine...");
  const dfn3 = createDfn3EngineFromBytes(wasmBytes, modelBytes);
  console.log("DFN3 engine ready");

  const files = readdirSync(FIX_DIR).filter((f) => f.endsWith("_noisy.wav")).sort();
  if (files.length === 0) throw new Error(`no *_noisy.wav fixtures in ${FIX_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  for (const f of files) {
    const { pcm, sr } = readWavMono16(join(FIX_DIR, f));
    const pipe = new FilePipeline({
      mode: "high_quality",
      suppression: 1.0,
      hpfCutoffHz: 80,
      agcEnabled: true,
      limiterEnabled: true,
    });
    pipe.setDfn3Engine(dfn3);
    const { blob } = await pipe.processPCM(pcm, sr);
    const outName = f.replace(/_noisy\.wav$/, "_processed.wav");
    writeFileSync(join(OUT_DIR, outName), Buffer.from(await blob.arrayBuffer()));
    console.log(`processed ${f} -> out/${outName} (${pcm.length} samples @${sr}Hz)`);
  }
  console.log(`done: ${files.length} file(s) -> ${OUT_DIR}`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
