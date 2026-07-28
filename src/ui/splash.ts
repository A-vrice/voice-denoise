/**
 * Splash screen overlay — auto-dismisses after 3s, on first pointer
 * interaction, or when the VAD model signals readiness.
 */
import { signal, effect, type Signal } from "@preact/signals-core";
import { el } from "../core/dom";

export function mountSplash(container: HTMLElement, ready: Signal<boolean>): () => void {
  const visible = signal(true);

  const overlay = el("div", {
    class: "splash",
    role: "status",
    "aria-label": "Loading VoiceDenoise",
  });
  const content = el("div", { class: "splash-content" });
  content.append(
    el("div", { class: "logo" }, "VoiceDenoise"),
    el("div", { class: "subtitle" }, "ブラウザ完結型 ノイズ除去ツール"),
    el("div", { class: "spinner" }),
  );
  overlay.append(content);

  // Dismiss handlers
  const dismiss = () => {
    visible.value = false;
  };
  const timeoutId = window.setTimeout(dismiss, 3000);
  const onPointer = () => dismiss();
  window.addEventListener("pointerdown", onPointer, { once: true });

  const readyEffect = effect(() => {
    if (ready.value) dismiss();
  });

  // Toggle visibility via class — CSS fadeOut handles the transition.
  // Remove from DOM when hidden — avoids an invisible fixed overlay
  // (z-index 9999, inset 0) lingering after the splash dismisses.
  let visTimerId = 0;
  const visEffect = effect(() => {
    if (visible.value) {
      overlay.classList.remove("splash-hidden");
    } else {
      overlay.classList.add("splash-hidden");
      visTimerId = window.setTimeout(() => overlay.remove(), 300);
    }
  });

  container.append(overlay);

  return () => {
    window.clearTimeout(timeoutId);
    window.removeEventListener("pointerdown", onPointer);
    readyEffect();
    window.clearTimeout(visTimerId);
    visEffect();
    overlay.remove();
  };
}
