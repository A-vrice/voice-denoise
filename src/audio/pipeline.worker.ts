/**
 * File processing worker — runs VAD+Gate+DFN3+post-chain off the main thread.
 * Loaded via `new Worker(new URL("./pipeline.worker.ts", import.meta.url))`
 * (Vite) or `dist/pipeline.worker.js` (prod via build-static).
 *
 * Protocol:
 *   main -> worker: { type: "process", id, pcm: Float32Array, sampleRate, options }
 *                 | { type: "cancel", id }
 *   worker -> main: { type: "progress", id, percent, etaMs }
 *                 | { type: "complete", id, pcm: Float32Array, wavBytes: ArrayBuffer, sampleRate }
 *                 | { type: "error", id, message }
 *
 * Transfer: pcm buffer is transferred to worker; result pcm is transferred back.
 * Cancel: aborts the job's AbortSignal, which the VAD/DFN3 loops observe at
 * their event-loop yields (event-loop.ts); no reply is sent for an aborted job.
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

// 実行中のジョブ id → そのジョブの AbortController。
// DFN3/VAD ループは event-loop.ts で定期的に譲歩するので、abort はそこで観測される。
const activeJobs = new Map<number, AbortController>();

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as {
    id: number;
    type: string;
    pcm?: Float32Array;
    sampleRate?: number;
    options?: ConstructorParameters<typeof FilePipeline>[0];
  };

  if (msg.type === "cancel") {
    activeJobs.get(msg.id)?.abort();
    return;
  }
  if (msg.type !== "process") return;

  const { id, pcm, sampleRate = 48000, options = {} } = msg;
  const post = (m: unknown, transfer?: Transferable[]) =>
    (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(
      m,
      transfer,
    );
  if (!pcm) {
    post({ type: "error", id, message: "missing pcm" });
    return;
  }

  const controller = new AbortController();
  activeJobs.set(id, controller);
  try {
    const vad = await getOrCreateVad();
    const dfn3 = options.mode === "high_quality" ? await getOrCreateDfn3() : null;
    const pipe = new FilePipeline(options, (ev) => {
      if (ev.type === "progress") {
        post({ type: "progress", id, percent: ev.percent, etaMs: ev.etaMs });
      }
    });
    if (vad) pipe.setVadEngine(vad);
    if (dfn3) pipe.setDfn3Engine(dfn3);
    const result = await pipe.processPCM(pcm, sampleRate, undefined, controller.signal);
    const wavBytes = await result.blob.arrayBuffer();
    post({ type: "complete", id, pcm: result.pcm, wavBytes, sampleRate }, [
      result.pcm.buffer as unknown as Transferable,
    ]);
  } catch (err) {
    // 中止はエラーではない。呼び出し側は既に AbortError で reject 済みなので
    // 何も返さない（late reply を無視する id チェックも client 側にある）。
    if (err instanceof DOMException && err.name === "AbortError") return;
    post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    activeJobs.delete(id);
  }
};
