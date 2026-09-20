# VoiceDenoise

ブラウザ完結型・高品質ノイズ除去ツール。サーバー通信ゼロで動作します。

> [!NOTE]
> **v0.2.0**（ファイル処理専用）。仕様の唯一の正は [`SPEC.md`](./SPEC.md) です。
> 本 README は要約で、詳細（アーキテクチャ・DFN3 の素性・目標値・既知課題）は
> SPEC.md を参照してください。

## 概要

- **入力**: WAV / MP3 / OGG / FLAC / M4A（Web Audio `decodeAudioData` 依存）
- **処理**: `VAD → Noise Gate → HPF → DeepFilterNet3 → Post-EQ → AutoGain → Limiter`
- **出力**: 16-bit モノラル WAV
- **対応環境**: Chrome / Edge（i7-8700 級デスクトップ、メモリ ≤200MB 目安）
- **品質目標**: PESQ ≥ 3.5 / STOI ≥ 0.95（仕様目標。合成ノイズの自前セットでは未達のため、
  CI は baseline からの回帰で判定します。詳細は SPEC.md §7.1 / §9.2）
- **初回ロード**: 約 38MB（モデル/WASM。2 回目以降は Service Worker キャッシュ）

リアルタイム（マイク入力・録音）は**非目標（凍結）**です。スタンダードモード
（DFN3 なし）はフォールバック/プレビュー用に同梱しています。

> [!IMPORTANT]
> セキュアコンテキスト（`localhost` または HTTPS）と COOP/COEP ヘッダーが必要です。
> ONNX Runtime Web の threaded wasm はクロスオリジン分離下でのみ複数スレッドを使うため、
> ヘッダーが無いと VAD 推論が単一スレッドになります。`public/_headers` に設定があります。

## クイックスタート

```bash
bun install          # 依存関係
bun run dev          # 開発サーバ (HMR) → http://localhost:5173/
bun run build        # プロダクションビルド → dist/
bun run preview      # dist をローカルプレビュー (COOP/COEP) → http://localhost:3000/
```

### 必要条件

| ツール | バージョン | 用途 |
|--------|:--------:|------|
| [Bun](https://bun.sh) | 1.2+ | ランタイム・ビルド・テスト |
| TypeScript | 6.0+ | 型チェック (`tsc --noEmit`) |
| Python + uv | 3.11+ | 品質ゲート（PESQ/STOI）のローカル実行 |

DFN3 の wasm/モデルは prebuilt を同梱しているため Rust ビルドは不要です。

## テスト

```bash
bun test              # 全テスト
bun run typecheck     # 型チェック
bun run format:check  # フォーマット
```

## デプロイ

Cloudflare Pages に一本化しています。

```bash
bun run build         # dist/ をデプロイ（wrangler.toml で設定）
```

## ライセンス

本体は MIT。同梱の DeepFilterNet3 wasm/モデルは上流に従い MIT OR Apache-2.0 です
（詳細は [`SPEC.md`](./SPEC.md) §4.3 / §4.5）。
