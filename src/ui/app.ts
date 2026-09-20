/**
 * App root — owns all UI state as signals, wires child components
 * (Splash / Waveform / Controls) and the audio pipeline/realtime/mic logic.
 */
import { signal, effect, type Signal } from "@preact/signals-core";
import { el } from "../core/dom";
import { mountSplash } from "./splash";
import { mountWaveform } from "./waveform";
import { mountControls, type ControlState } from "./controls";
import { type PipelineEvent } from "../audio/pipeline";
import { processInWorker } from "../audio/pipeline-client";
import { createVadEngine, type VadEngine } from "../audio/vad-engine";
import { downloadBlob } from "../audio/encoder";
import { playPcm, stopPlayback } from "../audio/player";
import { RealtimeProcessor } from "../audio/realtime";
import { decodeAudioFile } from "../audio/decoder";

export function mountApp(root: HTMLElement): () => void {
  // --- UI state ---
  const inputFileName = signal("");
  const inputPcm = signal<Float32Array | null>(null);
  const outputPcm = signal<Float32Array | null>(null);
  const outputBlob = signal<Blob | null>(null);

  const isProcessing = signal(false);
  const progress = signal(0);
  const etaText = signal("");
  const statusText = signal("");

  const engineMode = signal<"standard" | "high_quality">("standard");
  const vadThreshold = signal(0.5);
  const releaseMs = signal(50);
  const holdMs = signal(100);
  const suppression = signal(70);
  const hpfCutoffHz = signal(80);
  const agcEnabled = signal(true);
  const limiterEnabled = signal(true);

  const splashReady = signal(false);
  const isMicActive = signal(false);
  const isPlaying = signal(false);
  const abActive = signal(false);
  const isRecording = signal(false);

  let realtimeProcessor: RealtimeProcessor | null = null;
  let processAbort: AbortController | null = null;
  let playStopFn: (() => void) | null = null;
  let vadPromise: Promise<VadEngine | null> | null = null;

  // --- Shared VAD engine (lazy singleton) ---
  function getVadEngine(): Promise<VadEngine | null> {
    if (!vadPromise) {
      vadPromise = (async () => {
        try {
          const resp = await fetch("/models/silero_vad.onnx");
          const buf = await resp.arrayBuffer();
          return await createVadEngine(buf);
        } catch (err) {
          console.warn("Silero VAD model not loaded — running without VAD", err);
          vadPromise = null;
          return null;
        }
      })();
    }
    return vadPromise;
  }

  // --- Splash readiness ---
  // Signal splash readiness when VAD loads (with 15s timeout fallback).
  const vadLoadEffect = effect(() => {
    let done = false;
    const mark = () => {
      if (!done) {
        done = true;
        splashReady.value = true;
      }
    };
    getVadEngine().then(mark, mark);
    const t = window.setTimeout(mark, 15000);
    return () => window.clearTimeout(t);
  });

  // --- Playback helpers ---
  function stopPlay(): void {
    playStopFn?.();
    playStopFn = null;
    isPlaying.value = false;
  }

  function startPlay(pcm: Float32Array): void {
    stopPlayback();
    playStopFn = playPcm(pcm, 48000, () => {
      isPlaying.value = false;
      playStopFn = null;
    });
    isPlaying.value = true;
  }

  function currentAbPcm(): Float32Array | null {
    return abActive.value ? inputPcm.value : outputPcm.value;
  }

  // --- Handlers ---
  async function onMicToggle(): Promise<void> {
    if (isMicActive.value) {
      if (isRecording.value)
        try {
          realtimeProcessor?.stopRecording();
        } catch {}
      isRecording.value = false;
      realtimeProcessor?.stop();
      realtimeProcessor = null;
      isMicActive.value = false;
      statusText.value = "マイク停止";
      return;
    }
    try {
      statusText.value = "マイク起動中...";
      const proc = new RealtimeProcessor();
      const vad = await getVadEngine();
      if (vad) proc.setVadEngine(vad);
      await proc.start({
        vadThreshold: vadThreshold.value,
        mode: engineMode.value,
        hpfCutoffHz: hpfCutoffHz.value,
        agcEnabled: agcEnabled.value,
        limiterEnabled: limiterEnabled.value,
        suppression: suppression.value,
      });
      realtimeProcessor = proc;
      isMicActive.value = true;
      statusText.value = vad
        ? "マイク リアルタイム処理中..."
        : "VADモデル読み込み失敗（ゲート無効）";
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        statusText.value =
          "マイクへのアクセスが拒否されました。ブラウザの設定でマイクを許可してください。";
      } else {
        statusText.value = "マイクの起動に失敗しました。再試行してください。";
        console.error("mic error", err);
      }
    }
  }

  function onRecordToggle(): void {
    if (!realtimeProcessor) return;
    if (isRecording.value) {
      const blob = realtimeProcessor.stopRecording();
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `mic-recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        statusText.value = "録音を保存しました";
      }
      isRecording.value = false;
    } else {
      try {
        realtimeProcessor.startRecording();
        isRecording.value = true;
        statusText.value = "録音中...";
      } catch (err) {
        console.warn("record start failed", err);
        statusText.value = "録音の開始に失敗しました";
      }
    }
  }

  function onAbToggle(): void {
    abActive.value = !abActive.value;
    if (isPlaying.value) {
      const pcm = currentAbPcm();
      if (pcm) startPlay(pcm);
    }
  }

  function onPlayToggle(): void {
    if (isPlaying.value) {
      stopPlay();
      return;
    }
    const pcm = currentAbPcm();
    if (pcm) startPlay(pcm);
  }

  async function onFileSelected(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    inputFileName.value = file.name;
    isProcessing.value = true;
    progress.value = 0;
    statusText.value = "読み込み中...";

    try {
      const audio = await decodeAudioFile(file);
      inputPcm.value = audio.data;
      statusText.value = `${file.name} (${audio.duration.toFixed(1)}秒)`;
    } catch (err) {
      statusText.value =
        "ファイルの読み込みに失敗しました。対応していない形式か、ファイルが破損している可能性があります。";
      console.error("decode error", err);
    } finally {
      isProcessing.value = false;
    }
  }

  async function onProcess(): Promise<void> {
    if (!inputPcm.value || isProcessing.value) return;

    isProcessing.value = true;
    progress.value = 0;
    outputPcm.value = null;
    outputBlob.value = null;
    stopPlay();
    statusText.value = "初期化中...";

    const controller = new AbortController();
    processAbort = controller;

    try {
      // File processing is offloaded to a Worker (pipeline-client.ts) so
      // long files do not jank the main thread. The worker loads VAD and (for
      // high_quality) DFN3 itself; nothing is pre-fetched here.
      controller.signal.throwIfAborted();
      statusText.value = "処理中...";
      const result = await processInWorker(
        inputPcm.value,
        48000,
        {
          vadThreshold: vadThreshold.value,
          releaseMs: releaseMs.value,
          holdMs: holdMs.value,
          suppression: suppression.value / 100,
          mode: engineMode.value,
          hpfCutoffHz: hpfCutoffHz.value,
          agcEnabled: agcEnabled.value,
          limiterEnabled: limiterEnabled.value,
        },
        (ev: PipelineEvent) => {
          if (ev.type === "progress") {
            progress.value = ev.percent;
            etaText.value = ev.etaMs > 0 ? `残り ${Math.round(ev.etaMs / 1000)}秒` : "";
          }
        },
        controller.signal,
      );

      outputPcm.value = result.pcm;
      outputBlob.value = result.blob;
      statusText.value = "処理完了";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        statusText.value = "停止しました";
        outputPcm.value = null;
        outputBlob.value = null;
      } else {
        statusText.value = "エラー: 処理中に予期しないエラーが発生しました。再試行してください。";
        console.error("processing error", err);
      }
    } finally {
      processAbort = null;
      isProcessing.value = false;
      const st = statusText.value;
      if (st === "処理完了" || st.startsWith("エラー")) {
        progress.value = 100;
      } else {
        progress.value = 0;
      }
    }
  }

  function onStop(): void {
    processAbort?.abort();
  }

  function onDownload(): void {
    const blob = outputBlob.value;
    if (blob) {
      const name = inputFileName.value.replace(/\.[^.]+$/, "") || "output";
      downloadBlob(blob, `${name}_denoised.wav`);
    }
  }

  // --- DOM construction ---
  // Header
  const header = el("header", { class: "header" }, el("h1", { class: "logo" }, "VoiceDenoise"));

  // Waveform + Controls containers (children mount themselves).
  const waveformHost = el("div");
  const controlsHost = el("div");
  const main = el("main", { class: "main" }, waveformHost, controlsHost);

  // File actions
  const fileLabel = el("label", { class: "btn btn-primary" }, "📁 ファイル選択");
  const fileInput = el("input", { type: "file", accept: "audio/*" }) as HTMLInputElement;
  fileInput.hidden = true;
  fileInput.addEventListener("change", onFileSelected);
  fileLabel.append(fileInput);

  const micBtn = el("button", { class: "btn btn-primary" }, "🎤 マイク入力");
  micBtn.addEventListener("click", onMicToggle);
  // Frozen (non-goal, SPEC §6.1 / §14-13): the realtime engine is kept but the
  // mic/record UI is hidden. Re-enable by un-hiding both buttons.
  micBtn.hidden = true;

  const procBtn = el("button", { class: "btn btn-primary" }, "▶ 処理開始");
  procBtn.addEventListener("click", () => {
    if (isProcessing.value) onStop();
    else onProcess();
  });

  const dlBtn = el("button", { class: "btn btn-secondary" }, "💾 出力ダウンロード");
  dlBtn.addEventListener("click", onDownload);

  const playBtn = el("button", { class: "btn btn-secondary" }, "▶ 試聴");
  playBtn.addEventListener("click", onPlayToggle);

  const abBtn = el("button", { class: "btn btn-secondary" }, "▶ 出力");
  abBtn.addEventListener("click", onAbToggle);

  const recBtn = el("button", { class: "btn btn-secondary" }, "● 録音");
  recBtn.addEventListener("click", onRecordToggle);
  recBtn.hidden = true; // frozen (SPEC §6.1) — see note on micBtn above

  // Status bar
  const progressFill = el("div", { class: "progress-fill" });
  const progressBar = el("div", { class: "progress-bar" }, progressFill);
  const statusSpan = el("span", { class: "status-text" });
  const etaSpan = el("span", { class: "eta-text" });
  const statusBar = el("div", { class: "status-bar" }, progressBar, statusSpan, etaSpan);

  const fileActions = el(
    "div",
    { class: "file-actions" },
    fileLabel,
    micBtn,
    procBtn,
    dlBtn,
    playBtn,
    abBtn,
    recBtn,
    statusBar,
  );
  main.append(fileActions);

  const appDiv = el("div", { class: "app" }, header, main);
  root.append(appDiv);

  // --- Child mounts ---
  const cleanups: Array<() => void> = [];

  cleanups.push(mountWaveform(waveformHost, inputPcm, outputPcm, 48000, 120));

  const controlState: ControlState = {
    engineMode,
    vadThreshold,
    releaseMs,
    holdMs,
    suppression,
    hpfCutoffHz,
    agcEnabled,
    limiterEnabled,
    disabled: isProcessing,
  };
  cleanups.push(mountControls(controlsHost, controlState));

  cleanups.push(mountSplash(root, splashReady));

  // Live suppression update to worklet (high_quality realtime)
  cleanups.push(
    effect(() => {
      const v = suppression.value;
      realtimeProcessor?.setSuppression(v);
    }),
  );

  // --- Reactive bindings ---
  cleanups.push(
    effect(() => {
      micBtn.textContent = isMicActive.value ? "🎤 マイク停止" : "🎤 マイク入力";
      micBtn.className = `btn btn-${isMicActive.value ? "danger" : "primary"}`;
    }),
  );

  cleanups.push(
    effect(() => {
      procBtn.textContent = isProcessing.value ? "⏸ 停止" : "▶ 処理開始";
      procBtn.disabled = !inputPcm.value && !isProcessing.value;
    }),
  );

  cleanups.push(
    effect(() => {
      dlBtn.disabled = !outputBlob.value;
    }),
  );

  cleanups.push(
    effect(() => {
      const show = outputPcm.value !== null;
      playBtn.hidden = !show;
      abBtn.hidden = !show;
    }),
  );

  cleanups.push(
    effect(() => {
      recBtn.textContent = isRecording.value ? "■ 停止して保存" : "● 録音";
      recBtn.className = `btn btn-${isRecording.value ? "danger" : "secondary"}`;
    }),
  );

  cleanups.push(
    effect(() => {
      recBtn.hidden = !isMicActive.value;
      recBtn.disabled = !isMicActive.value;
    }),
  );

  cleanups.push(
    effect(() => {
      playBtn.textContent = isPlaying.value ? "⏹ 試聴停止" : "▶ 試聴";
    }),
  );

  cleanups.push(
    effect(() => {
      abBtn.textContent = abActive.value ? "▶ 入力" : "▶ 出力";
    }),
  );

  cleanups.push(
    effect(() => {
      const showProgress = isProcessing.value || progress.value > 0;
      progressBar.hidden = !showProgress;
      etaSpan.hidden = !showProgress;
      if (showProgress) {
        progressFill.style.width = `${progress.value}%`;
        statusSpan.textContent = statusText.value;
        etaSpan.textContent = etaText.value;
      } else {
        statusSpan.textContent = statusText.value || "ファイルを選択して処理を開始";
      }
    }),
  );

  return () => {
    for (const c of cleanups) c();
    vadLoadEffect();
    stopPlay();
    try {
      realtimeProcessor?.stopRecording();
    } catch {}
    realtimeProcessor?.stop();
    processAbort?.abort();
    appDiv.remove();
  };
}
