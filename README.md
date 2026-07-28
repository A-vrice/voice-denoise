# VoiceDenoise

ブラウザ完結型 高品質ノイズ除去ツール。サーバー通信ゼロ、WASM＋AudioWorkletで動作。

## 機能

- **ファイル処理**: WAV/MP3/FLAC/M4A を読み込み、ノイズ除去して WAV 出力
- **スタンダードモード**: VAD + Noise Gate (低遅延 ~17ms)
- **高品質モード**: VAD + Gate + DeepFilterNet3 + Post-EQ (~48ms, 準備中)
- **リアルタイム処理**: マイク入力に AudioWorklet で VAD Gate 適用
- **PWA対応**: オフライン動作、インストール可能

## クイックスタート

```bash
# 依存関係インストール
bun install

# 開発サーバー起動
bun run dev
# → http://localhost:5173/

# プロダクションビルド
bun run build
# → dist/
```

## アーキテクチャ

```
Main Thread                    AudioWorklet Thread
┌─────────────────────┐       ┌──────────────────┐
|  UI (vanilla TS + @preact/signals-core) |       |  VAD Gate        |
│  File I/O           │◄─────►│  (128 samples/frame)
│  ORT Web (VAD)      │       │  Ring Buffer     │
│  DFN3 Engine (wasm) │       │  (4096 samples)  │
└─────────────────────┘       └──────────────────┘
```

## ビルド

```bash
# WASMビルド全般
bun run build:dfn3

# フロントエンド
bun run build
```

### 必要条件

| ツール | 用途 |
|--------|------|
| Node.js 24+ | フロントエンドビルド |
| Rust 1.97+ | DFN3 WASM (wasm32-unknown-unknown) |
| Emscripten 3.1.74+ | Silero VAD C→WASM (将来用) |
| Python 3.11+ (uv) | 品質テストツール |

## 品質テスト

```bash
uv run tools/quality_test.py --ref clean.wav --deg processed.wav
```

PESQ ≥ 3.5 / STOI ≥ 0.95 が目標。

## ライセンス

MIT

## 参考

- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) — 深層フィルタリングによるノイズ除去
- [Silero VAD](https://github.com/snakers4/silero-vad) — 音声区間検出
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) — ブラウザONNX推論
