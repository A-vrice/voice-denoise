// Remove build output. Split out from `build` so it runs BEFORE build:bundle —
// hashed chunk names leave stale files behind otherwise (a 25.58 MiB leftover
// from a July build exceeded Cloudflare Pages' 25 MiB per-file limit).
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
console.log("cleaned dist/");
