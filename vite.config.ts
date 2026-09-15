import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Vite's dev-server transform middleware refuses to serve `.mjs` files from
 * `public/` (treats them as source modules that must go through the plugin
 * pipeline). ONNX Runtime Web loads `ort-wasm-simd-threaded.mjs` as a Worker
 * at runtime via an absolute `/wasm/...` URL, so the browser requests it from
 * the dev server directly. This plugin intercepts those requests BEFORE Vite's
 * transform pipeline and serves the file as a static asset with the correct
 * content-type, mirroring how `vite build` copies `public/` as-is.
 */
function servePublicWasm(): Plugin {
  return {
    name: "serve-public-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        // Only handle /wasm/*.mjs (and optionally .wasm) requests
        // M-3: allowlist — directory traversal 対策で fileName に / と \ を拒否
        if (!url.startsWith("/wasm/")) return next();
        const rawName = url.split("/").pop()?.split("?")[0] ?? "";
        if (!rawName || rawName.includes("/") || rawName.includes("\\") || rawName.includes("..")) return next();
        if (!/^[a-zA-Z0-9._-]+\.(mjs|wasm)$/.test(rawName)) return next();
        const fileName = rawName;
        const filePath = resolve("public/wasm", fileName);
        try {
          const content = readFileSync(filePath);
          const ext = fileName.split(".").pop();
          res.setHeader(
            "Content-Type",
            ext === "mjs" ? "text/javascript" : "application/wasm",
          );
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          res.end(content);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    port: 3000,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    assetsInlineLimit: 0,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  plugins: [servePublicWasm()],
});
