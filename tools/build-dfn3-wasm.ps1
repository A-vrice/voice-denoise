<#
.SYNOPSIS
  Build the DeepFilterNet libDF wasm (with LTO) and run wasm-opt -O4.

.DESCRIPTION
  Helper for tools/build-dfn3-wasm.md. Requires a pinned DeepFilterNet checkout and
  RAM 16GB+ (tract-onnx wasm32 builds are memory-hungry; use CARGO_BUILD_JOBS=1).
  Does NOT modify the repo: outputs to -OutDir for manual verification/replacement.

.PARAMETER DeepFilterNetDir
  Path to a DeepFilterNet checkout (pinned to a tag/commit).

.PARAMETER OutDir
  Staging output directory (default: ../dfn3-build-out).

.PARAMETER CrateDir
  Crate directory within the checkout that exposes the wasm feature (default: libDF).

.PARAMETER SkipWasmOpt
  Skip the wasm-opt step.
#>
param(
  [Parameter(Mandatory = $true)][string]$DeepFilterNetDir,
  [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) "dfn3-build-out"),
  [string]$CrateDir = "libDF",
  [switch]$SkipWasmOpt
)

$ErrorActionPreference = "Stop"

foreach ($c in @("cargo", "rustup", "wasm-pack")) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "missing required tool: $c" }
}
if (-not $SkipWasmOpt -and -not (Get-Command wasm-opt -ErrorAction SilentlyContinue)) {
  throw "missing wasm-opt (binaryen). Install binaryen or pass -SkipWasmOpt."
}

$cratePath = Join-Path $DeepFilterNetDir $CrateDir
if (-not (Test-Path $cratePath)) { throw "crate dir not found: $cratePath" }

rustup target add wasm32-unknown-unknown
$env:CARGO_BUILD_JOBS = "1"
$env:RUSTFLAGS = "-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals,+sign-ext,+reference-types,+multivalue"

Write-Host "NOTE: ensure [profile.release] has opt-level=3 / lto=""thin"" / codegen-units=1 / panic=""abort"" in $CrateDir/Cargo.toml"

Push-Location $cratePath
try {
  wasm-pack build --target web --release --features wasm
} finally {
  Pop-Location
}

$pkg = Join-Path $cratePath "pkg"
if (-not (Test-Path $pkg)) { throw "wasm-pack output not found: $pkg" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item (Join-Path $pkg "*") $OutDir -Recurse -Force

$wasm = Get-ChildItem $OutDir -Filter "*_bg.wasm" | Select-Object -First 1
if (-not $wasm) { throw "no *_bg.wasm produced in $OutDir" }
$wasmPath = $wasm.FullName

if (-not $SkipWasmOpt) {
  $opt = Join-Path $OutDir "df_bg.opt.wasm"
  wasm-opt -O4 `
    --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int `
    --enable-mutable-globals --enable-reference-types --enable-multivalue --enable-sign-ext `
    $wasmPath -o $opt
  $wasmPath = $opt
}

$sizeMB = [math]::Round((Get-Item $wasmPath).Length / 1MB, 2)
Write-Host "built: $wasmPath ($sizeMB MB)"
Write-Host "next: verify the glue/exports and run the checks in tools/build-dfn3-wasm.md"
