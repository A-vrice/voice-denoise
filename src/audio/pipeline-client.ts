/**
 * Client for pipeline.worker.ts — main-thread facade that mirrors FilePipeline#processPCM
 * but executes inside a Worker. Falls back to main-thread FilePipeline when Worker
 * is unavailable (e.g. file://, CSP block).
 */
import { FilePipeline, type PipelineOptions, type PipelineEvent } from "./pipeline";
import { createVadEngine } from "./vad-engine";
import { encodeWav } from "./encoder";

export type { PipelineEvent, PipelineOptions };

let workerPromise: Promise<Worker> | null = null;
let workerUnavailable = false;

function getWorker(): Promise<Worker> | null {
  if (workerUnavailable) return null;
  if (workerPromise) return workerPromise;
  try {
    // Vite/bun: "./pipeline.worker.ts" resolved at build time to emitted chunk.
    // Prod (bun --no-splitting for worker, Vite bundled): dist/pipeline.worker.js
    // The URL string is patched by build-static.ts in dist/main.js (.ts -> .js).
    const w = new Worker(new URL("./pipeline.worker.ts", import.meta.url), { type: "module" });
    workerPromise = Promise.resolve(w);
    w.addEventListener("error", () => {
      workerUnavailable = true;
      workerPromise = null;
    });
    return workerPromise;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

let nextId = 1;

/**
 * Offload PCM processing to worker when possible; otherwise run on main thread.
 * Returns { blob, pcm } like FilePipeline#processPCM.
 */
export async function processInWorker(
  pcm: Float32Array,
  sampleRate: number,
  options: Partial<PipelineOptions>,
  onEvent?: (ev: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; pcm: Float32Array }> {
  signal?.throwIfAborted();
  const wp = getWorker();
  if (!wp) return fallbackMainThread(pcm, sampleRate, options, onEvent, signal);

  let worker: Worker;
  try {
    worker = await wp;
  } catch {
    return fallbackMainThread(pcm, sampleRate, options, onEvent, signal);
  }

  const id = nextId++;
  // Transfer a copy to keep inputPcm reactive value intact; worker gets ownership of the copy.
  const copy = new Float32Array(pcm);

  return new Promise<{ blob: Blob; pcm: Float32Array }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Worker request cannot be cancelled; just ignore its late reply by id check.
      reject(new DOMException("Aborted", "AbortError"));
    };
    const onErr = (e: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      console.warn("[pipeline-client] worker error, falling back", e);
      fallbackMainThread(pcm, sampleRate, options, onEvent, signal).then(resolve, reject);
    };
    const onMsg = (e: MessageEvent) => {
      const m = e.data as { id: number; type: string; percent?: number; etaMs?: number; pcm?: Float32Array; wavBytes?: ArrayBuffer; message?: string };
      if (m.id !== id) return;
      if (m.type === "progress") {
        onEvent?.({ type: "progress", percent: m.percent ?? 0, etaMs: m.etaMs ?? 0 });
      } else if (m.type === "complete") {
        if (settled) return;
        settled = true;
        cleanup();
        const outPcm = m.pcm ?? new Float32Array();
        const blob = m.wavBytes ? new Blob([m.wavBytes], { type: "audio/wav" }) : encodeWav(outPcm, sampleRate);
        onEvent?.({ type: "progress", percent: 100, etaMs: 0 });
        onEvent?.({ type: "complete" });
        resolve({ blob, pcm: outPcm });
      } else if (m.type === "error") {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(m.message ?? "worker error"));
      }
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Transfer ownership of the copy's buffer to the worker
    worker.postMessage({ type: "process", id, pcm: copy, sampleRate, options }, [copy.buffer]);
  });
}

async function fallbackMainThread(
  pcm: Float32Array,
  sampleRate: number,
  options: Partial<PipelineOptions>,
  onEvent?: (ev: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; pcm: Float32Array }> {
  const pipe = new FilePipeline(options, onEvent);
  // Load VAD on main thread for fallback path (best-effort)
  try {
    const resp = await fetch("/models/silero_vad.onnx");
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      const vad = await createVadEngine(buf);
      pipe.setVadEngine(vad);
    }
  } catch {
    // no VAD — still process
  }
  signal?.throwIfAborted();
  return pipe.processPCM(pcm, sampleRate, onEvent, signal);
}
