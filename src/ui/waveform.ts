/**
 * Waveform display — dual-track canvas (input / output) with min/max
 * vertical lines per pixel column and RMS-ratio coloring on the output.
 */
import { effect, signal, type Signal } from "@preact/signals-core";
import { el } from "../core/dom";

export function mountWaveform(
  container: HTMLElement,
  inputPcm: Signal<Float32Array | null>,
  outputPcm: Signal<Float32Array | null>,
  sampleRate = 48000,
  height = 120,
): () => void {
  const canvas = el("canvas", { class: "waveform-canvas" });
  canvas.height = height;
  const wrap = el("div", { class: "waveform-container" }, canvas);
  container.append(wrap);

  const ctx = canvas.getContext("2d");
  if (!ctx) return () => wrap.remove();

  const widthSig = signal(canvas.clientWidth);

  const resize = () => {
    widthSig.value = canvas.clientWidth;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const drawEffect = effect(() => {
    const input = inputPcm.value;
    if (!input) return;

    const dpr = window.devicePixelRatio || 1;
    const w = widthSig.value;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const trackH = (h - 16) / 2;

    ctx.fillStyle = "#666";
    ctx.font = "11px sans-serif";
    ctx.fillText("入力", 8, 14);

    drawZeroLine(ctx, "#333", 20, trackH, w);
    drawWaveform(ctx, input, "#3b82f6", 20, trackH, w);

    const output = outputPcm.value;
    if (output) {
      ctx.fillStyle = "#666";
      ctx.fillText("出力", 8, 22 + trackH);
      drawZeroLine(ctx, "#333", 24 + trackH, trackH, w);
      drawWaveform(ctx, output, "#22c55e", 24 + trackH, trackH, w, input);
    }
  });

  return () => {
    ro.disconnect();
    drawEffect();
    wrap.remove();
  };
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  color: string,
  offsetY: number,
  h: number,
  width: number,
  referenceData?: Float32Array,
): void {
  const len = data.length;
  if (len === 0 || width <= 0) return;

  const halfH = h / 2;
  const centerY = offsetY + halfH;
  ctx.lineWidth = 1;

  let currentColor: string | null = null;
  let pathOpen = false;

  for (let x = 0; x < width; x++) {
    const start = Math.floor((x / width) * len);
    const end = Math.max(start + 1, Math.min(Math.floor(((x + 1) / width) * len), len));

    let min = Infinity;
    let max = -Infinity;
    let rmsIn = 0;
    let rmsOut = 0;
    for (let i = start; i < end; i++) {
      const v = data[i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
      if (referenceData) {
        const r = referenceData[i] ?? 0;
        rmsIn += r * r;
        rmsOut += v * v;
      }
    }

    let segColor = color;
    if (referenceData) {
      const ratio = Math.sqrt(rmsOut / Math.max(rmsIn, 1e-10));
      segColor = ratio > 0.3 ? "#22c55e" : "#444";
    }

    if (segColor !== currentColor) {
      if (pathOpen) ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = segColor;
      currentColor = segColor;
      pathOpen = true;
    }

    const yMin = centerY - max * halfH * 0.9;
    const yMax = centerY - min * halfH * 0.9;
    ctx.moveTo(x + 0.5, yMin);
    ctx.lineTo(x + 0.5, yMax);
  }
  if (pathOpen) ctx.stroke();
}

function drawZeroLine(
  ctx: CanvasRenderingContext2D,
  color: string,
  offsetY: number,
  h: number,
  width: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([4, 4]);
  const midY = offsetY + h / 2;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();
  ctx.setLineDash([]);
}
