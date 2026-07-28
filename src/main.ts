import "./style.css";
import { mountApp } from "./ui/app";

mountApp(document.getElementById("app")!);

// Register Service Worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}
