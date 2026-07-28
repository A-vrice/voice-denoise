# Changelog

## 0.1.0 (2026-07-23)

VoiceDenoise — ブラウザ完結型ノイズ除去ツール。初回実装（一括セッション）。

### Phase 1: 基本機能
- bun + Vite 6 + TypeScript 6 strict + @preact/signals-core プロジェクト構成
- COOP/COEP ヘッダー設定 (Cross-Origin Isolation)
- AudioWorklet + SPSC RingBuffer (SharedArrayBuffer)
- Audio decoder (Web Audio API → 48kHz PCM)
- WAV encoder (PCM → 16-bit WAV)
- Silero VAD v6 (ONNX Runtime Web)
- Noise Gate (5状態FSM, 等功率クロスフェード)
- FilePipeline orchestrator
- Waveform canvas表示 + Controls UI

### Phase 2: DFN3統合
- extern "C" ABI wasm スタブ (dfn3_init/process/reset)
- dfn3-engine.ts JSローダー
- Post-EQ (Biquad HighShelf +2dB @8kHz)
- 高品質モードパイプライン (VAD→Gate→DFN3→Post-EQ)
- DeepFilterNet3 本ビルド試行 → OOM 確認済み
- Dockerfile + ビルド手順書 (16GB+ RAM要件)

### Phase 3: PWA
- Service Worker (Cache-First / Stale-While-Revalidate / Network-First)
- Web App Manifest + iOS meta tags
- PWA icons (192px/512px) + screenshot
- オフライン動作対応

### Phase 4: リアルタイム
- AudioWorkletProcessor (VAD Gate inline)
- RealtimeProcessor (getUserMedia → AudioWorklet)
- マイク入力ボタン + A/B比較トグル

### Phase 5: 最適化・品質
- JSEP WASM除去 (26MB → 15.8MB)
- 型エラー9件 → 0件修正
- Vitest + 18テスト (vad-gate, encoder, ring-buffer)
- GitHub Actions CI
- Vercel / Netlify デプロイ設定
- 品質テストスクリプト (PESQ/STOI)
- README.md + DFN3ビルドREADME
- スプラッシュスクリーン
- 抑制強度スライダー (条件付き表示)


## 0.1.1 (2026-07-24)

### 新機能: HPF / Auto Gain / Limiter
- HighPassFilter — 2次 Butterworth biquad HPF (デフォルト 80Hz), NaNガード付き
- AutoGain — RMSベース自動レベル正規化 (target -15dBFS, attack 10ms/release 200ms, max +12dB)
- Limiter — ピークエンベロープフォロワ + 4:1ソフトニー (threshold -2dB), 最終 ±1 ハードクランプ付き(ルックアヘッドなしでも過渡ピーク保護)
- 各モジュールに vitest 単体テスト (13件追加、全36件パス)
- ファイル処理パイプラインに HPF→AGC→Limiter ポストチェーン統合
- AudioWorklet にインライン DSP 実装 (リアルタイムマイク処理)
- Controls UI に HPF スライダー + AGC/Limiter トグル追加

### 修正: 既存問題
- P3: VADダウンサンプルを3タップボックス平均から 1次IIRローパス(fc≈7kHz@48k) + 3:1間引きに変更
- P4: 波形描画をサンプル折れ線から min/maxペア垂直線に置換(dpr>1での描画不具合も修正)
- U5: ファイル読込/処理/マイク のエラーメッセージを日本語ユーザー向け案内に置換
- U6: Splash を3秒固定から VADモデルロード完了(または15秒タイムアウト)連動に変更
- U7: 出力波形をRMS比で発話区間(緑)/無音区間(暗灰)に色分け