// Copy static assets into dist/ and patch index.html to load the bundled JS.
// Replaces the inline `node -e` script so the build pipeline is bun-only.
import { cpSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
copyFileSync("index.html", "dist/index.html");

// Patch: JS entry path + inject CSS link (bun build emits main.css as a
// separate asset but does not add a <link> tag, so styles would be missing).
const html = readFileSync("dist/index.html", "utf8")
  .replace("/src/main.ts", "./main.js")
  .replace("</head>", '  <link rel="stylesheet" href="./main.css">\n  </head>');
writeFileSync("dist/index.html", html);
console.log("static assets copied + index.html patched");
