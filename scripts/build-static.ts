// Copy static assets into dist/ and patch index.html to load the bundled JS.
// Also bundles src/audio/pipeline.worker.ts to dist/pipeline.worker.js
// (bun build --splitting for src/main.ts does not emit Worker chunks)
// and patches dist/main.js to reference the built .js instead of .ts.
import { cpSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// NOTE: dist/ のクリーンは `bun run clean`（build の先頭）が行う。ここで消すと、
// 先に走る build:bundle が出力した dist/main.js を消してしまう。
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
copyFileSync("index.html", "dist/index.html");

// Build file-processing worker to dist/pipeline.worker.js
{
  const r = spawnSync(
    "bun",
    [
      "build",
      "--target",
      "browser",
      "--minify",
      "--outdir",
      "dist",
      "src/audio/pipeline.worker.ts",
    ],
    {
      stdio: "inherit",
    },
  );
  if (r.status !== 0)
    console.warn("[build-static] worker build failed, standard-file fallback will be used");
  // Bun emits dist/pipeline.worker.js (normalize: if nested, move)
  // Ensure the file exists at root for new URL("./pipeline.worker.js", import.meta.url) in dist/main.js
  if (!existsSync("dist/pipeline.worker.js") && existsSync("dist/src/audio/pipeline.worker.js")) {
    copyFileSync("dist/src/audio/pipeline.worker.js", "dist/pipeline.worker.js");
  }
}

// Patch: JS entry path + inject CSS link (bun build emits main.css as a
// separate asset but does not add a <link> tag, so styles would be missing).
const html = readFileSync("dist/index.html", "utf8")
  .replace("/src/main.ts", "./main.js")
  .replace("</head>", '  <link rel="stylesheet" href="./main.css">\n  </head>');
writeFileSync("dist/index.html", html);
// Patch main.js worker URL: "./pipeline.worker.ts" -> "./pipeline.worker.js"
{
  try {
    const mainPath = "dist/main.js";
    const main = readFileSync(mainPath, "utf8");
    if (main.includes("pipeline.worker.ts")) {
      writeFileSync(mainPath, main.replaceAll("pipeline.worker.ts", "pipeline.worker.js"));
    }
  } catch {}
}
// Inline DFN wasm glue into the worklet (AudioWorklet has no dynamic import).
{
  const raw = readFileSync("src/audio/df.js", "utf8");
  const inlined = raw
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith("export {") || t.startsWith("export{")) return "";
      if (t.startsWith("export ")) return line.replace(/export\s+/, "");
      return line;
    })
    .join("\n");
  const wp = "dist/audio/worklet-processor.js";
  const body = readFileSync(wp, "utf8");
  const preamble =
    inlined +
    "\nglobalThis.initSync=initSync;globalThis.df_create=df_create;globalThis.df_get_frame_length=df_get_frame_length;globalThis.df_process_frame=df_process_frame;globalThis.df_set_atten_lim=df_set_atten_lim;\n";
  writeFileSync(wp, preamble + body);
}
console.log("static assets copied + index.html patched");
