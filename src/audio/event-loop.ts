/**
 * Explicit hand-off to the event loop, shared by the VAD window loop
 * (`pipeline.ts`) and the DFN3 frame loop (`dfn3-engine.ts`).
 *
 * Both loops are long and CPU-bound (ORT promise chains / synchronous wasm
 * calls). Without a periodic macro-task boundary inside them, input events and
 * rendering starve — and in a Worker that also means an incoming `cancel`
 * message is never read, so the stop button does nothing until the whole file
 * finishes.
 *
 * Uses setTimeout rather than MessageChannel on purpose. A MessageChannel
 * boundary keeps the *message* task source busy and starves the *timer* task
 * source: measured on Bun, a loop that alternates ~50ms of synchronous work
 * with a MessageChannel yield never fires an armed setTimeout at all, and an
 * abort scheduled from a timer consequently arrived only after the DFN3 pass had
 * already run to completion. setTimeout yields into the timer queue, so timers
 * and worker messages both get serviced. The browser's nested-timer clamp
 * (~4ms) costs a few percent of throughput at the current yield intervals
 * (4 VAD windows ≈128ms of audio; 200 DFN frames ≈96ms), which is the right
 * trade for a stop button that actually stops.
 *
 * CLI note: a pending timer keeps a Bun process alive, so tools/*.ts that
 * import this (transitively) must call process.exit() — run_chain.ts does.
 */
export function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}
