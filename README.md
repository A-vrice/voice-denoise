# VoiceDenoise

ブラウザ完結型・高品質ノイズ除去ツール。サーバー通信ゼロ、WASM + AudioWorklet で動作。

> [!NOTE]
> 現在 **v0.1.1**。リアルタイム VAD ゲートとファイル処理が安定。DeepFilterNet3 統合は準備中。

## 対応ブラウザ

| ブラウザ | 最低バージョン | 備考 |
|----------|:------------:|------|
| Chrome / Edge | ≥91 | 推奨 |
| Safari | ≥17 | |
| Firefox | ≥89 | SIMD+スレッド対応が限定的、パフォーマンス低下の可能性あり |

> [!IMPORTANT]
> AudioWorklet + SharedArrayBuffer のため**セキュアコンテキスト必須**（`localhost` または HTTPS）。
> COOP/COEP ヘッダーが正しく設定されている必要があります。

---

## 機能

| 機能 | 説明 | 状態 |
|------|------|:----:|
| **ファイル処理** | WAV/MP3/FLAC/M4A → ノイズ除去 → WAV 出力 | ✅ |
| **スタンダードモード** | VAD (Silero v6) + Noise Gate（5 状態 FSM、等功率クロスフェード）遅延 ~17ms | ✅ |
| **高品質モード** | VAD + Gate + DeepFilterNet3 + Post-EQ 遅延 ~48ms | 🚧 |
| **リアルタイム処理** | マイク入力 → AudioWorklet で VAD Gate（HPF / AGC / Limiter 内蔵） | ✅ |
| **PWA 対応** | Service Worker（Cache-First / SWR / Network-First）、オフライン動作 | ✅ |

### DSP チェーン

```
入力 PCM
  → HighPassFilter  (2次 Butterworth biquad, デフォルト 80Hz)
  → VAD              (Silero VAD v6, ONNX Runtime Web)
  → Noise Gate       (5状態FSM: Closed→Attacking→Open→Hold→Releasing)
  → AutoGain         (RMS ベース, target -15dBFS, attack 10ms / release 200ms)
  → Limiter          (ピークエンベロープフォロワ, 4:1 ソフトニー, threshold -2dB)
  → [DFN3]           (DeepFilterNet3 WASM, 準備中)
  → Post-EQ          (Biquad HighShelf +2dB @8kHz)
  → WAV エンコード出力
```

---

## スクリーンショット

![VoiceDenoise Screenshot](public/screenshot.png)

---

## クイックスタート

```bash
# 依存関係インストール
bun install

# 開発サーバー起動 (HMR)
bun run dev
# → http://localhost:5173/

# プロダクションビルド
bun run build
# → dist/

# ビルド成果物のローカルプレビュー
bun run preview
# → http://localhost:3000/
```

### 必要条件

| ツール | バージョン | 用途 |
|--------|:--------:|------|
| [Bun](https://bun.sh) | 1.2+ | ランタイム・ビルド・テスト |
| TypeScript | 6.0+ | 型チェック (`tsc --noEmit`) |
| Rust | 1.97+ | DFN3 WASM ビルド (`wasm32-unknown-unknown`) |
| Python + uv | 3.11+ | 品質テスト (PESQ/STOI) |

---

## プロジェクト構成

```
voice-denoise/
├── src/
│   ├── audio/          # DSP / WASM / pipeline
│   │   ├── vad-engine.ts      # Silero VAD (ORT Web)
│   │   ├── vad-gate.ts        # Noise Gate (5状態FSM)
│   │   ├── pipeline.ts        # ファイル処理パイプライン
│   │   ├── realtime.ts        # マイクリアルタイム管理
│   │   ├── dfn3-engine.ts     # DFN3 WASM ローダー
│   │   ├── hpf.ts             # HighPassFilter
│   │   ├── auto-gain.ts       # RMS 自動ゲイン
│   │   ├── limiter.ts         # ピークリミッター
│   │   ├── post-eq.ts         # ポストEQ
│   │   ├── player.ts          # PCM 再生
│   │   ├── encoder.ts         # WAV エンコード
│   │   ├── decoder.ts         # 音声ファイルデコード
│   │   └── ring-buffer.ts     # SPSC RingBuffer
│   ├── ui/             # UI コンポーネント (vanilla TS + signals)
│   │   ├── app.ts             # アプリルート
│   │   ├── controls.ts        # パラメータ操作パネル
│   │   ├── waveform.ts        # 波形表示 (min/max 垂直線)
│   │   └── splash.ts          # スプラッシュ画面
│   ├── core/dom.ts     # DOM ヘルパー (JSX 不要)
│   ├── style.css       # 全スタイル (CSS カスタムプロパティ)
│   └── main.ts         # エントリポイント
├── public/
│   ├── audio/worklet-processor.js  # AudioWorklet (VAD Gate DSP inline)
│   ├── sw.js                       # Service Worker
│   ├── models/                     # ONNX モデル (silero_vad.onnx)
│   └── wasm/                       # ORT WASM ランタイム
├── scripts/
│   ├── build-static.ts    # dist 静的最終化
│   └── preview.ts         # COOP/COEP ローカルサーバー
├── wasm/
│   ├── deepfilternet/     # Rust → WASM (DFN3 スタブ)
│   └── silero-vad/        # C 実装 (将来用)
├── tools/quality_test.py  # PESQ/STOI 品質評価
├── wrangler.toml           # Cloudflare Pages 設定
└── bunfig.toml             # Bun プロジェクト設定
```

---

## テスト

```bash
# 全テスト実行
bun test

# 型チェック
bun run typecheck

# フォーマットチェック
bun run format:check

# フォーマット適用
bun run format
```

### 品質テスト（音質評価）

```bash
uv run tools/quality_test.py --ref clean.wav --deg processed.wav
```

目標: PESQ ≥ 3.5 / STOI ≥ 0.95

---

## アーキテクチャ

```
Main Thread                          AudioWorklet Thread
┌──────────────────────────┐         ┌──────────────────────┐
│ UI (vanilla TS + signals) │         │ VoiceDenoiseProcessor │
│                          │         │                      │
│ FilePipeline ─────────┐  │  post   │  DSP inline:         │
│  decode ─ VAD ─ gate  │  │◄───────►│  HPF → AGC → Limiter │
│  ─ DFN3 ─ EQ ─ encode │  │ Message │  → VAD Gate          │
│                        │  │         │                      │
│ RealtimeProcessor      │  │         │ RingBuffer           │
│  ─ getUserMedia        │  │         │ (SharedArrayBuffer)  │
│  ─ AudioWorklet        │  │         └──────────────────────┘
│  ─ VAD (main thread)   │  │
└──────────────────────────┘
```

- **ファイル処理**: メインスレッドで全 DSP → WAV 出力
- **リアルタイム**: AudioWorklet でインライン DSP → VAD 確率のみメインスレッドへ送信
- **スレッド間通信**: `postMessage` + SPSC RingBuffer

---

## デプロイ

### Cloudflare Pages

```bash
bun run build
# dist/ をデプロイ (wrangler.toml で自動設定)
```

### 手動デプロイ

```bash
bun run build
# dist/ を任意の静的ホスティングへ
```

> [!IMPORTANT]
> 静的サーバーは **COOP/COEP ヘッダー**が必須です（`SharedArrayBuffer` 用）。
> `public/_headers` に Cloudflare Pages 用の設定が含まれています。

---

## 技術スタック

| レイヤ | 技術 |
|--------|------|
| ランタイム | [Bun](https://bun.sh) |
| 言語 | TypeScript 6.0 (strict) |
| UI | vanilla DOM + [`@preact/signals-core`](https://github.com/preactjs/signals) |
| VAD | [Silero VAD v6](https://github.com/snakers4/silero-vad) + [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) |
| ノイズ除去 | [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) (Rust → WASM) |
| ビルド | `bun build --minify --splitting` |
| 開発サーバー | [Vite](https://vitejs.dev) (COOP/COEP HMR) |
| テスト | `bun:test` |
| フォーマット | Prettier |
| デプロイ | Cloudflare Pages |

---

## ライセンス

MIT

---

## 参考

- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) — 深層フィルタリングノイズ除去
- [Silero VAD](https://github.com/snakers4/silero-vad) — 音声区間検出
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) — ブラウザ ONNX 推論
- [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) — MDN
- [SharedArrayBuffer / COOP/COEP](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) — MDN
