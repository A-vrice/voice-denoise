/**
 * File processing worker — runs VAD+Gate+DFN3+post-chain off the main thread.
 * Loaded via `new Worker(new URL("./pipeline.worker.ts", import.meta.url))`
 * (Vite) or `dist/pipeline.worker.js` (prod via build-static).
 *
 * Protocol:
 *   main -> worker: { type: "process", id, pcm: Float32Array, sampleRate, options }
 *   worker -> main: { type: "progress", id, percent, etaMs }
 *                 | { type: "complete", id, pcm: Float32Array, wavBytes: ArrayBuffer, sampleRate }
 *                 | { type: "error", id, message }
 *
 * Transfer: pcm buffer is transferred to worker; result pcm is transferred back.
 */
import { FilePipeline } from "./pipeline";
import { createVadEngine, type VadEngine } from "./vad-engine";
import { getDfn3Engine, type Dfn3Engine } from "./dfn3-engine";

let cachedVad: VadEngine | null = null;
let cachedVadKey = "";
let cachedDfn3: Dfn3Engine | null | undefined;

async function getOrCreateVad(): Promise<VadEngine | null> {
  const key = "/models/silero_vad.onnx";
  if (cachedVad && cachedVadKey === key) return cachedVad;
  try {
    const resp = await fetch(key);
    if (!resp.ok) throw new Error(`fetch ${key}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    cachedVad = await createVadEngine(buf);
    cachedVadKey = key;
    return cachedVad;
  } catch (err) {
    console.warn("[worker] VAD load failed, running without VAD", err);
    return null;
  }
}

async function getOrCreateDfn3(): Promise<Dfn3Engine | null> {
  if (cachedDfn3 !== undefined) return cachedDfn3 ?? null;
  try {
    const e = await getDfn3Engine();
    cachedDfn3 = e;
    return e;
  } catch (err) {
    console.warn("[worker] DFN3 load failed", err);
    cachedDfn3 = null;
    return null;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as {
    type: string;
    id: number;
    pcm?: Float32Array;
    sampleRate?: number;
    options?: ConstructorParameters<typeof FilePipeline>[0];
  };
  if (msg.type !== "process") return;
  const { id, pcm, sampleRate = 48000, options = {} } = msg;
  if (!pcm) {
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
      type: "error",
      id,
      message: "missing pcm",
    });
    return;
  }
  try {
    const vad = await getOrCreateVad();
    const dfn3 = options.mode === "high_quality" ? await getOrCreateDfn3() : null;
    const pipe = new FilePipeline(options, (ev) => {
      if (ev.type === "progress") {
        (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
          type: "progress",
          id,
          percent: ev.percent,
          etaMs: ev.etaMs,
        });
      }
    });
    if (vad) pipe.setVadEngine(vad);
    if (dfn3) pipe.setDfn3Engine(dfn3);
    const result = await pipe.processPCM(pcm, sampleRate);
    const wavBytes = await result.blob.arrayBuffer();
    (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(
      { type: "complete", id, pcm: result.pcm, wavBytes, sampleRate },
      [result.pcm.buffer as unknown as Transferable],
    );
  } catch (err) {
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
