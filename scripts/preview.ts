// Minimal static file server with COOP/COEP headers for local preview.
// Serves dist/ on http://localhost:3000 with correct MIME types for wasm.
import { createServer } from "node:http";
import { readFile } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const DIR = "dist";
const PORT = 3000;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
};
const HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

createServer((req, res) => {
  const url = decodeURIComponent(req.url ?? "/").split("?")[0];
  let fp = join(DIR, url);
  // Prevent path traversal out of DIR
  if (!resolve(fp).startsWith(resolve(DIR) + sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (url === "/" || !extname(fp)) fp = join(DIR, "index.html");
  readFile(fp, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(fp)] ?? "application/octet-stream",
      ...HEADERS,
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`preview: http://localhost:${PORT}`);
});
