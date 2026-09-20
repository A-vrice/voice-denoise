# DFN3 wasm 自前ビルド手順（LTO によるサイズ削減）

現行 `public/wasm/df_bg.wasm` は wasm-opt 未適用・LTO なしのビルドで **16.4MB**。
上流 DeepFilterNet の `libDF`（`--features wasm`）を最適化設定でビルドし、`wasm-opt -O4`
を適用して **~9–10MB**（mezon 版相当）を狙う。

> 実行環境: **RAM 16GB+（推奨 32GB）**。tract-onnx の wasm32 ビルドはメモリ消費が大きく、
> 少 RAM では OOM する（本リポジトリの開発機 7.8GB では実行不可）。
> 標準 GitHub ランナー(7GB) でも不可 → 32GB 機 or larger runner を使う。

## 前提ツール
- Rust stable + wasm32: `rustup target add wasm32-unknown-unknown`
- `cargo install wasm-pack`
- `wasm-opt`（binaryen）

## 手順

1. **ソースを pin して取得**
   ```bash
   git clone https://github.com/Rikorose/DeepFilterNet
   cd DeepFilterNet && git checkout <tag-or-commit>   # 再現性のため pin
   ```
   本リポジトリの wasm は libDF の wasm 機能（`df_*` エクスポート; §4.3）由来。

2. **`libDF/Cargo.toml` の `[profile.release]` を最適化**
   ```toml
   [profile.release]
   opt-level = 3
   lto = "thin"
   codegen-units = 1
   panic = "abort"
   ```

3. **ビルド（メモリ抑制のためジョブ数 1）**
   ```bash
   export CARGO_BUILD_JOBS=1
   export RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals,+sign-ext,+reference-types,+multivalue"
   wasm-pack build --target web --release --features wasm
   ```

4. **wasm-opt で最適化**
   ```bash
   wasm-opt -O4 \
     --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int \
     --enable-mutable-globals --enable-reference-types --enable-multivalue --enable-sign-ext \
     pkg/<crate>_bg.wasm -o df_bg.opt.wasm
   ```

5. **ABI / glue の整合（重要）**
   - 生成された glue（`pkg/<crate>_bg.js`）をそのまま `src/audio/df.js` として採用する。
     wasm-bindgen の版が変わると import 名（ハッシュ付き）が変わるため、**glue と wasm は
     同一ビルドのペア**で使うこと。
   - エクスポートが次を満たすことを確認:
     `df_create` / `df_get_frame_length` / `df_process_frame` / `df_set_atten_lim` /
     `df_set_post_filter_beta`（`src/audio/dfn3-engine.ts` と `dfn3-wasm.test.ts` が依存）。
   - 一致しない場合は `src/audio/dfn3-engine.ts` の import 名を合わせる。

6. **検証（置換前に対象ファイルを退避）**
   ```bash
   # 置換
   cp df_bg.opt.wasm public/wasm/df_bg.wasm
   cp pkg/<crate>_bg.js src/audio/df.js
   # 検証
   bun run typecheck
   bun test src/audio/dfn3-engine.test.ts src/audio/dfn3-wasm.test.ts
   bun tools/quality/run_chain.ts
   python tools/quality_gate.py --skip-pesq   # 回帰がないこと
   ```
   `tools/quality/out/timing.json` の steady RTF が悪化していないことも確認。

7. **採用時の更新**
   - `SPEC.md` §4.5（ハッシュ・サイズ）、§4.1、§4.3 を更新。
   - `public/sw.js` の `CACHE_NAME` / `MODEL_CACHE` を bump（モデル/WASM 更新の M-1 ルール）。
   - 期待サイズ: ~9–10MB。ハッシュを再計算して記録。

## 補助スクリプト
`tools/build-dfn3-wasm.ps1` が手順 3–4 と staging 出力を補助する（ABI/glue の最終確認と
リポジトリへの反映は手動）。
