import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serve byte-exact assets from `public/` in dev and preview.
 *
 * Two problems with Vite's own static serving, both of which silently break the
 * app while `bun test` / `run_chain.ts` (which read from disk) stay green:
 *
 * 1. `.mjs` in `public/` is treated as source and pushed through the transform
 *    pipeline, so ONNX Runtime Web cannot load `ort-wasm-simd-threaded.mjs`.
 * 2. sirv derives `Content-Encoding` from the *filename* (`.gz` → `gzip`), so
 *    `/models/DeepFilterNet3_onnx.tar.gz` — which is genuinely gzip-compressed
 *    and is passed to `df_create` as-is — gets transparently decompressed by the
 *    browser. `df_create` then receives a plain tar and traps (`unreachable`),
 *    so DFN3 quietly fell back to standard quality.
 *
 * We therefore serve these paths ourselves with the correct content types and a
 * literal byte count, and pin `Content-Encoding: identity` so no double-decode
 * can happen. Production (Cloudflare Pages / any plain static host) serves the
 * same files untouched, so this only aligns dev and preview with production.
 */
function servePublicAssets(): Plugin {
  const middleware = (
    req: { url?: string },
    res: {
      setHeader(k: string, v: string): void;
      end(body: unknown): void;
      statusCode: number;
    },
    next: () => void,
  ) => {
    const url = req.url ?? "";
    const dir = url.startsWith("/models/")
      ? "public/models"
      : url.startsWith("/wasm/")
        ? "public/wasm"
        : null;
    if (!dir) return next();

    // M-3: allowlist — directory traversal 対策で fileName に / と \ を拒否
    const rawName = url.split("/").pop()?.split("?")[0] ?? "";
    if (!rawName || rawName.includes("/") || rawName.includes("\\") || rawName.includes("..")) {
      return next();
    }
    // Only paths whose bytes must reach the browser unmodified.
    const isAsset =
      /^[a-zA-Z0-9._-]+\.(mjs|wasm)$/.test(rawName) || /^[a-zA-Z0-9._-]+\.tar\.gz$/.test(rawName);
    if (!isAsset) return next();

    try {
      const content = readFileSync(resolve(dir, rawName));
      res.setHeader(
        "Content-Type",
        rawName.endsWith(".mjs")
          ? "text/javascript"
          : rawName.endsWith(".wasm")
            ? "application/wasm"
            : "application/gzip",
      );
      res.setHeader("Content-Encoding", "identity");
      res.setHeader("Content-Length", String(content.byteLength));
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.end(content);
    } catch {
      next();
    }
  };

  return {
    name: "serve-public-assets",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
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
  plugins: [servePublicAssets()],
});
