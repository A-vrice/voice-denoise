/**
 * Controls panel — engine mode, VAD/gate parameters, HPF, AGC, limiter.
 * Two-way binds each control to a Signal from ControlState.
 */
import { signal, effect, type Signal } from "@preact/signals-core";
import { el, type Children } from "../core/dom";

export interface ControlState {
  engineMode: Signal<"standard" | "high_quality">;
  vadThreshold: Signal<number>;
  releaseMs: Signal<number>;
  holdMs: Signal<number>;
  suppression: Signal<number>;
  hpfCutoffHz: Signal<number>;
  agcEnabled: Signal<boolean>;
  limiterEnabled: Signal<boolean>;
  disabled: Signal<boolean>;
}

export function mountControls(container: HTMLElement, state: ControlState): () => void {
  const effects: Array<() => void> = [];
  const track = (fn: () => void) => effects.push(effect(fn));

  const root = el("div", { class: "controls" });

  // --- Engine selection ---
  const engineGroup = el(
    "section",
    { class: "control-group" },
    el("h3", { class: "group-title" }, "エンジン選択"),
  );

  const stdLabel = el(
    "label",
    { class: "radio-row" },
    el("input", { type: "radio", name: "mode", value: "standard" }),
    el(
      "span",
      { class: "radio-label" },
      "スタンダード",
      el("span", { class: "radio-desc" }, "(VAD Gateのみ／超低遅延)"),
    ),
  );
  const stdRadio = stdLabel.querySelector("input") as HTMLInputElement;
  stdRadio.addEventListener("change", () => {
    if (stdRadio.checked) state.engineMode.value = "standard";
  });

  const hqLabel = el(
    "label",
    { class: "radio-row" },
    el("input", { type: "radio", name: "mode", value: "high_quality" }),
    el(
      "span",
      { class: "radio-label" },
      "高品質",
      el("span", { class: "radio-desc" }, "(DFN3実装中)"),
    ),
  );
  const hqRadio = hqLabel.querySelector("input") as HTMLInputElement;
  hqRadio.addEventListener("change", () => {
    if (hqRadio.checked) state.engineMode.value = "high_quality";
  });

  engineGroup.append(stdLabel, hqLabel);
  root.append(engineGroup);

  // --- Parameters ---
  const paramGroup = el(
    "section",
    { class: "control-group" },
    el("h3", { class: "group-title" }, "パラメータ"),
  );

  const vadRow = makeSlider(
    "vad-threshold",
    "VAD感度",
    "0.1",
    "0.9",
    "0.05",
    state.vadThreshold,
    (v) => v.toFixed(2),
  );
  const releaseRow = makeSlider(
    "release-ms",
    "リリース",
    "10",
    "200",
    "5",
    state.releaseMs,
    (v) => `${v}ms`,
  );
  const holdRow = makeSlider(
    "hold-ms",
    "ホールド",
    "0",
    "500",
    "10",
    state.holdMs,
    (v) => `${v}ms`,
  );
  const hpfRow = makeSlider("hpf-cutoff", "HPF", "0", "200", "10", state.hpfCutoffHz, (v) =>
    v === 0 ? "オフ" : `${v}Hz`,
  );
  paramGroup.append(vadRow.row, releaseRow.row, holdRow.row, hpfRow.row);

  const agcLabel = makeCheckbox("agc", "自動レベル調整", state.agcEnabled);
  const limiterLabel = makeCheckbox("limiter", "リミッター", state.limiterEnabled);
  paramGroup.append(agcLabel.label, limiterLabel.label);

  // Suppression slider — only visible in high_quality mode.
  const supp = makeSlider(
    "suppression",
    "抑制強度",
    "0",
    "100",
    "5",
    state.suppression,
    (v) => `${v}%`,
  );
  paramGroup.append(supp.row);
  const suppEffect = effect(() => {
    supp.row.hidden = state.engineMode.value !== "high_quality";
  });
  effects.push(suppEffect);

  root.append(paramGroup);
  container.append(root);

  // Sync radio checked state from signal.
  track(() => {
    const mode = state.engineMode.value;
    stdRadio.checked = mode === "standard";
    hqRadio.checked = mode === "high_quality";
  });

  // Sync disabled state across all inputs.
  track(() => {
    const dis = state.disabled.value;
    const inputs = root.querySelectorAll("input");
    for (const inp of inputs) {
      (inp as HTMLInputElement).disabled = dis;
    }
    const labels = root.querySelectorAll(".radio-row, .checkbox-row");
    for (const lab of labels) {
      lab.classList.toggle("disabled", dis);
    }
  });

  // Cleanup all effects plus slider/checkbox listeners.
  const cleanups = [
    vadRow.cleanup,
    releaseRow.cleanup,
    holdRow.cleanup,
    hpfRow.cleanup,
    supp.cleanup,
  ];
  return () => {
    for (const e of effects) e();
    for (const c of cleanups) c();
    root.remove();
  };
}

interface SliderHandle {
  row: HTMLDivElement;
  cleanup: () => void;
}

function makeSlider(
  id: string,
  label: string,
  min: string,
  max: string,
  step: string,
  sig: Signal<number>,
  fmt: (v: number) => string,
): SliderHandle {
  const input = el("input", { id, type: "range", min, max, step }) as HTMLInputElement;
  const value = el("span", { class: "slider-value" });
  const row = el(
    "div",
    { class: "slider-row" },
    el("label", { class: "slider-label", for: id }, label),
    el("div", { class: "slider-input" }, input, value),
  ) as HTMLDivElement;

  const onInput = () => {
    sig.value = parseFloat(input.value);
  };
  input.addEventListener("input", onInput);

  const sync = effect(() => {
    const v = sig.value;
    input.value = String(v);
    value.textContent = fmt(v);
  });

  return {
    row,
    cleanup: () => {
      input.removeEventListener("input", onInput);
      sync();
    },
  };
}

interface CheckboxHandle {
  label: HTMLLabelElement;
  cleanup: () => void;
}

function makeCheckbox(id: string, text: string, sig: Signal<boolean>): CheckboxHandle {
  const input = el("input", { id, type: "checkbox" }) as HTMLInputElement;
  const label = el(
    "label",
    { class: "checkbox-row" },
    input,
    el("span", {}, text),
  ) as HTMLLabelElement;

  const onChange = () => {
    sig.value = input.checked;
  };
  input.addEventListener("change", onChange);

  const sync = effect(() => {
    input.checked = sig.value;
  });
  return {
    label,
    cleanup: () => {
      input.removeEventListener("change", onChange);
      sync();
    },
  };
}
