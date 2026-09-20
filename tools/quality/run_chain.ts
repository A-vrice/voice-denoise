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
  const modelBytes = new Uint8Array(
    readFileSync(join(ROOT, "public/models/DeepFilterNet3_onnx.tar.gz")),
  );
  console.log("loading DFN3 engine...");
  const dfn3 = createDfn3EngineFromBytes(wasmBytes, modelBytes);
  console.log("DFN3 engine ready");

  const files = readdirSync(FIX_DIR)
    .filter((f) => f.endsWith("_noisy.wav"))
    .sort();
  if (files.length === 0) throw new Error(`no *_noisy.wav fixtures in ${FIX_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const timings: Array<Record<string, number | string>> = [];
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
    const t0 = performance.now();
    const { blob } = await pipe.processPCM(pcm, sr);
    const processMs = performance.now() - t0;
    const outName = f.replace(/_noisy\.wav$/, "_processed.wav");
    writeFileSync(join(OUT_DIR, outName), Buffer.from(await blob.arrayBuffer()));
    const audioS = pcm.length / sr;
    timings.push({
      file: f,
      samples: pcm.length,
      sr,
      audio_s: Number(audioS.toFixed(3)),
      process_ms: Math.round(processMs),
      rtf: Number((processMs / 1000 / audioS).toFixed(3)),
    });
    console.log(`processed ${f} -> out/${outName} (RTF ${(processMs / 1000 / audioS).toFixed(3)})`);
  }
  // Throughput (steady-state): one long signal in a single call, plus the cost
  // of one engine reset (df_create re-parses the model), which is otherwise
  // included in the per-file one-shot numbers above.
  const rt0 = performance.now();
  dfn3.reset();
  const resetMs = performance.now() - rt0;
  const { pcm: p0, sr: sr0 } = readWavMono16(join(FIX_DIR, files[0]!));
  const reps = Math.max(1, Math.ceil(30 / (p0.length / sr0)));
  const longPcm = new Float32Array(p0.length * reps);
  for (let r = 0; r < reps; r++) longPcm.set(p0, r * p0.length);
  const tp = new FilePipeline({
    mode: "high_quality",
    suppression: 1.0,
    hpfCutoffHz: 80,
    agcEnabled: true,
    limiterEnabled: true,
  });
  tp.setDfn3Engine(dfn3);
  const t1 = performance.now();
  await tp.processPCM(longPcm, sr0);
  const tpMs = performance.now() - t1;
  const tpAudio = longPcm.length / sr0;
  const throughput = {
    audio_s: Number(tpAudio.toFixed(3)),
    process_ms: Math.round(tpMs),
    reset_ms: Math.round(resetMs),
    rtf: Number((tpMs / 1000 / tpAudio).toFixed(3)),
    rtf_steady: Number(((tpMs - resetMs) / 1000 / tpAudio).toFixed(3)),
  };

  const totalMs = timings.reduce((s, t) => s + Number(t.process_ms), 0);
  const totalAudio = timings.reduce((s, t) => s + Number(t.audio_s), 0);
  const summary = {
    clips: timings,
    total: {
      process_ms: totalMs,
      audio_s: Number(totalAudio.toFixed(3)),
      rtf: Number((totalMs / 1000 / totalAudio).toFixed(3)),
    },
    throughput,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "timing.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `done: ${files.length} file(s) -> ${OUT_DIR} (one-shot RTF ${summary.total.rtf}; ` +
      `steady RTF ${throughput.rtf_steady} over ${throughput.audio_s}s, reset ${throughput.reset_ms}ms)`,
  );
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
