# DeepFilterNet3 WASM

## 現在の状態: スタブ

`lib.rs` は extern "C" の簡易スタブ（入力を `gain = 1.0 - atten * 0.5` で減衰）。
実際のノイズ除去処理は含まれていません。

## 本ビルドの手順

```bash
# Cargo.toml に deep_filter 依存を追加
# [dependencies]
# deep_filter = { git = "https://github.com/Rikorose/DeepFilterNet", features = ["wasm"] }

cd wasm/deepfilternet
cargo build --target wasm32-unknown-unknown --release
wasm-pack build --target web --release

# 生成物
#   pkg/dfn3_bg.wasm   — WASM バイナリ
#   pkg/dfn3.js         — JS グルーコード
cp pkg/dfn3_bg.wasm ../../public/wasm/dfn3.wasm
```

## モデル重みの入手

DeepFilterNet3 のモデル重み (`dfn3_model.bin`) は以下のいずれかから入手:

- **Hugging Face**: https://huggingface.co/Rikorose/DeepFilterNet
- **GitHub Releases**: https://github.com/Rikorose/DeepFilterNet/releases
- **自作**: `python3 -m deep_filter.export` で ONNX エクスポート後、`model_optimizer.py` で変換

ファイルを `public/models/dfn3_model.bin` に配置してください。

## 既知の問題: tract-onnx OOM

DeepFilterNet3 の wasm32 クロスコンパイルは tract-onnx の LLVM-IR 中間表現生成時に
大量のメモリを消費します。このマシンでは全滅しました:

| opt-level | LTO | codegen-units | 結果 |
|-----------|-----|---------------|------|
| 3 | fat | 1 | ❌ OOM (tract-onnx-opl) |
| 2 | thin | 1 | ❌ OOM (tract-core) |
| 1 | false | 16 | ❌ OOM (tract-core + tract-onnx) |

**必要条件**:
- RAM 16GB 以上 (推奨 32GB)
- `CARGO_BUILD_JOBS=1` でビルド (並列コンパイル抑制)
- Windows より Linux の方がメモリ効率が良い場合あり

## スタブのビルド

```bash
cd wasm/deepfilternet
cargo build --target wasm32-unknown-unknown --release
mkdir -p pkg
cp target/wasm32-unknown-unknown/release/deepfilternet3_wasm.wasm pkg/dfn3_bg.wasm
cat pkg/dfn3_bg.wasm > ../../public/wasm/dfn3.wasm
```

ビルド時間: ~3秒

## ライセンス

DeepFilterNet 本体: MIT / Apache-2.0 デュアルライセンス
