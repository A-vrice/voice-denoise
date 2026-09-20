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
## 0.2.0 (2026-08-27)

### Phase 1-5 完成: ORT 正式化 + Worker + DFN3 高品質 + PWA v3
- **goal.md §4.2/5.1/8.2**: Silero VAD を ONNX Runtime Web 正式採用（C→WASM 温存）へ改訂。メモリ ~82MB / 初回DL ≈38MB（当時の「~27MB」は誤り。SPEC §5.1/§5.2 で実測 ≈38.4 MiB に訂正済み）
- **ORT**: `ort-wasm-simd-threaded.wasm` 13.2MB + `silero_vad.onnx` 2.2MB。v5/v6 STFT+dw/pw conv 対応
- **ファイル処理 Worker**: `pipeline.worker.ts` (0.42MB) + `pipeline-client.ts` で VAD/Gate をメインスレッド外へ。`AbortSignal` / フォールバック付き
- **DFN3 高品質**: `df_bg.wasm` 15.7MB + `DeepFilterNet3_onnx.tar.gz` 7.8MB を Worker 内でロード。`getDfn3Engine` シングルトン共用
- **Post-EQ**: `OfflineAudioContext` → RBJ highshelf biquad (Worker 対応) に置換
- **リアルタイム**: `RealtimeConfig.suppression` + `setSuppression()` で worklet へライブ反映
- **PWA**: `sw.js` v2→v3 bump（`~38MB`。当初の `~27MB` は誤りで SPEC §5.2 で訂正済み）
- **UI/ドキュメント**: レイテンシ表記を goal §7.1 準拠（standard ~38ms / high-quality ~69ms）に修正。Worker 記述を `README` アーキテクチャに反映
- **ビルド**: `scripts/build-static.ts` が Worker を `dist/pipeline.worker.js` へ emit、`dist/main.js` の `.ts→.js` パッチ
