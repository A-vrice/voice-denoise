仕様書: ブラウザ完結型 ノイズ除去ツール（v13 — 最終目標 確定）

    *改訂履歴*

     - *v1*: 初版。RNNoise 後段チェーン + DFN3、レイテンシを「推論計算時間」のみで
       見積もり（過小評価）。
     - *v2*: RNNoise 段を削除、レイテンシを累積値で再計算。Silero VAD を ONNX
       Runtime Web 正式採用（2026-08-27）。
     - *v3*: 実装の現状に全面整合（事実と目標を分離）。
     - *v4*: 最終目標を確定。質問ベースで 9 項目を決定（§14-1..9）。
     - *v5*: 残余未決 4 項目を決定（§14-10..13）。本書を唯一の正とする。
     - *v6*: 調査（DFN3 の素性 / 品質データセット）を実施し 2 項目を決定
       （§14-3 改訂・§14-14）。出所を実測で特定（§4.3）し資産ハッシュを記録（§4.5）。
     - *v7*: *§12 のパイプライン正確性（W1）を実装*。チェーン順序の
       組み替え・DFN3 warmup・`reset()` 実装・出所コメント修正。実測により
       *§12-2（atten_lim）は誤指摘*と判明（マッピングは正しい）。DFN3 の入出力は
       時間整列（lag 0）と実測 — warmup は pad+trim ではなくクロスフェードで実装。
     - *v8*: *§12 のテスト追加（W4）*。pipeline のチェーン順序、DFN3 wasm の整列
       （実測）、Post-EQ のテストを追加（44 テスト / 10 ファイル）。
     - *v9（本版）*: *wasm-opt の検証（W3）*。`-O2/-O3/-O4` いずれもサイズ効果は
       実質なし（−2.5KB〜−35KB、code セクション 14.67MB は不変）。mezon 版 9.6MB は
       ABI 非互換かつビルド設定差（LTO 等）由来と判明。wasm-opt 方針は撤回し
       16.4MB を維持、サイズ削減は将来の自前ビルド（LTO 等）で検討する。
     - *v10*: *VAD ダウンサンプル改善（W2）*。1 次 IIR を 49 タップ線形位相
     FIR（Blackman, fc=7kHz）+ 3:1 デシメーションに置換（実測で 8kHz 以上 ≈0）。
     テスト 47 件 / 11 ファイル。
     - *v11*: *クリーンアップ（W6）*。`package.json`=0.2.0、`sw.js` サイズ
     実値化、README を要約化（唯一の正を `SPEC.md` としてリポジトリ内へ移設）。
     `wasm/` / `Dockerfile` / 旧 `dfn3.wasm` / `dist-worker/` / `demo-*.wav`（input
     を除く）を削除。
     - *v12*: *品質ゲート（W5）+ DFN3 遅延補償*。自前固定セット（CMU ARCTIC
       クリーン + 合成ピンクノイズ、8 ペア）+ チェーンハーネス + 回帰ベースの CI ゲート
       （§9.2）。DFN3 deep-filter の 3 フレーム遅延を pad+trim で補償（STOI 0.79→0.875
       @0dB SNR）。テスト 50 件 / 12 ファイル。
     - *v13（本版）*: *CI baseline + RTF 計測*。CI(Linux) で baseline を再生成（STOI は
       ローカルと一致、PESQ を記入。PESQ ≈1.1–1.9）。`run_chain.ts` に RTF 計測
       （one-shot / steady）を追加し、report / timing を artifact 化。§7.2 に実測 RTF を
       記録（CI one-shot 0.19 / steady 0.07、ローカル 0.52 / 0.26）。

------------------------------------------------------------------------

      0. 本文書の位置づけと凡例

  - *現状（実装済み）*: リポジトリ `voice-denoise/` のコードに実在する挙動。
  - *目標（確定）*: §14 で合意した最終目標。未実装のものは「（未実装）」と明記。
  - *非目標（凍結）*: 将来再開の可能性はあるが、現目標からは外したもの。
  - *未決*: 残る小項目（§15）。
  - リポジトリ: `voice-denoise/`（本体）、`voice-denoise/SPEC.md`（本文書・唯一の正）。

------------------------------------------------------------------------

      1. 目的・スコープ（確定）

  項目	  内容	区分
  目的	  48kHz フルバンドの音声ノイズ除去を、サーバー通信ゼロでブラウザ完結	確定
  対象ユーザー	  声優・ナレーター・ポッドキャスター・配信者	確定
  処理形態	  *ファイル処理（オフライン）専用*	確定
  	  	  	リアルタイム処理は非目標（§2・凍結）
  処理モード	  高品質（DFN3 + スタンダード一式）／スタンダード（DFN3 なし。
  	  	  	フォールバック・プレビュー用に維持）	確定
  非対象	  音楽制作（マスタリング級 EQ/コンプ）、リアルタイム通話（WebRTC）、
  	  	  	リアルタイム処理全般	確定
  出力形式	  *16-bit モノラル WAV のみ*（MP3/OGG/FLAC は非目標）	確定
  対応環境	  *i7-8700 級デスクトップ*（Chrome/Edge 主対象）。メモリ上限 200MB	確定
  	  	  	NAT-VPS(512MB) / Surface Go 4 は目標から撤回
  品質目標	  PESQ ≥ 3.5 / STOI ≥ 0.95	確定
  	  	  	*自前の固定セット*（CC0/CC-BY クリーン + CC0 ノイズ）で CI 判定（§9.2）
  速度目標	  実測してから閾値を設定（CI で回帰検出）	確定
  	  	  	数値は実測後に本書へ追記（§7.2）

  > v3 の「性能目標（目標・未検証）」にあった RTF ≤ 0.05 は撤回。wasm 構成での
  > 現実的な値は実測後に確定する。

------------------------------------------------------------------------

      2. 全体アーキテクチャ（目標）

  目標とする構成は *メインスレッド + ファイル処理 Worker + Service Worker*。
  リアルタイム（AudioWorklet）は非目標・凍結（コードは温存、§2.4）。

  |┌───────────────────────────────────────────────────────────┐
  │                    Main Thread (JS/TS)                     │
  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
  │  │ UI           │  │ decode/encode│  │ VAD 推論 (ORT) │  │
  │  │ vanilla TS + │  │ Web Audio /  │  │ silero_vad.onnx│  │
  │  │ signals      │  │ WAV          │  │                │  │
  │  └──────────────┘  └──────────────┘  └────────────────┘  │
  │  ┌───────────────────────────────────────────────────────┐│
  │  │ pipeline-client（Worker ファサード / メインfallback） ││
  │  └───────────────────────────────────────────────────────┘│
  └───────────────────────────┬───────────────────────────────┘
                              │ postMessage（PCM は Transferable）
                              ▼
  ┌───────────────────────────────────────────────────────────┐
  │ Worker (File processing: pipeline.worker)                 │
  │   VAD → Gate → HPF → DFN3 → PostEQ → AGC → Limiter → WAV   │
  └───────────────────────────────────────────────────────────┘

  Service Worker (PWA): モデル/WASM を Cache-First、UI を SWR/Network-First

  WASM/モデル資産（実サイズ・ハッシュは §4.1 / §4.5）:
    - `silero_vad.onnx` (2.2MB) + ONNX Runtime Web (`ort-wasm-simd-threaded.wasm`
      12.9MB + `.mjs` 23.6KB) … VAD 推論
    - `df_bg.wasm` (16.4MB、wasm-opt 適用後は ~9–10MB 見込み) +
      `DeepFilterNet3_onnx.tar.gz` (7.6MB) … DFN3

        2.4 非目標（凍結）

  以下はコードを温存しつつ、最終目標からは除外する（「実験的・非目標」と明示）:
  `src/audio/realtime.ts`、`public/audio/worklet-processor.js`、`ring-buffer.ts`
  （SAB）、MediaRecorder による録音、旧 §7.1 のレイテンシ予算、Safari SAB
  対応、NAT-VPS のリアルタイム用途。UI のマイク/録音ボタンは非表示とする
  （§6.1）。

------------------------------------------------------------------------

      3. 音声処理パイプライン

        3.1 チェーン（実装済み）

  ファイル処理のチェーン（実装済み）:

  |VAD → Noise Gate → HPF → DeepFilterNet3 → Post-EQ → AutoGain → Limiter → WAV|

  - DFN3 を先に通し、レベル正規化/保護を後段に置く（DFN3 にクリーンな入力を
    与え、最後にレベルとピークを整える）。
  - スタンダードモード（DFN3 なし）= `VAD → Gate → HPF → AutoGain → Limiter`。
    フォールバック/プレビュー用に維持する。DFN3 ロード失敗時はこのモードへ
    フォールバックする。
  - 実装: `src/audio/pipeline.ts`（`runVadGate` / `applyHpf` / `applyPostChain`
    の段構成、高品質は DFN3 → Post-EQ を間挿）。

  進捗通知: VAD 段を先頭側、DFN3/PostEQ 以降を後半に割当。長い音声で
  postMessage が溢れないよう *約 100ms 間隔に間引き*（最終窓は必ず emit）。
  キャンセル: `AbortSignal` 対応。`cancel` メッセージ（client → worker）→
  `AbortController` → VAD 窓ループ / DFN3 フレームループで観測、の経路で
  *Worker 内の処理も実際に中断する*（`pipeline.abort.test.ts` はメインスレッド
  経路、`dfn3-engine.test.ts` は DFN3 途中 abort を検証）。実測 60 秒音声の
  高品質処理を 3 秒後に停止 → UI 反映 517ms。
  > キャンセルは「ループがイベントループへ譲歩している」ことが前提。譲歩を
  > `MessageChannel` で行うとタイマー/メッセージのタスクソースが飢餓して abort が
  > 完走後にしか届かないため、`event-loop.ts` は `setTimeout` ベース（変えないこと）。

        3.2 バッファ設計（現状）

  - ファイル処理: 入力 PCM を `Transferable` で Worker へ転送（SAB 未使用）。
  - VAD 単位: 48kHz 換算 1536 samples（=512 @16kHz、32ms）。
  - DFN3 フレーム: 480 samples（10ms ホップ）。末尾の端数フレームはゼロ詰め。

        3.3 Noise Gate 仕様（実装値・現状維持）

  パラメータ	実装値	UI 範囲	備考
  状態機械	5状態 FSM: Closed→Attacking→Open→Hold→Releasing	-	`src/audio/vad-gate.ts`
  閾値	  0.5	0.1–0.9（step 0.05）	発話判定
  アタック	  5ms	-	固定
  リリース	  50ms	10–200ms（step 5）	
  ホールド	  100ms	0–500ms（step 10）	
  減衰量	  -∞ dB（gain 0）	-	非発話区間
  クロスフェード	  等功率（progress² カーブ）	-	クリック防止
  VAD 平滑	  EMA（alpha=0.5）	-	`VadSmoother`、窓ごと補間

        3.4 DeepFilterNet3 / Post-EQ 設定

  パラメータ	値	備考
  サンプリングレート	  48kHz	`df_create(modelBytes, atten_lim)`
  フレーム長	  480 samples（`df_get_frame_length`）	10ms ホップ
  STFT	  960 / 480（frame / hop）	上流アルゴリズム（設計値）
  look-ahead	  *実測 3 フレーム（1440 samples, 30ms）*	atten>0 で deep-filter が出力を遅延（atten=0 は bypass で遅延 0）。engine が pad+trim で補償（§4.3）
  抑制強度	  UI 0–100% → `df_set_atten_lim()`	0=低減なし / 100=最大低減。マッピングは正しい（§12）
  post filter beta	 未使用（API は存在）	`df_set_post_filter_beta`
  Post-EQ	  +2dB @8kHz, Q=0.7（RBJ highshelf）	`src/audio/post-eq.ts`
  warmup	  先頭 `fl*3`(1440) サンプルを等功率で入力→DFN出力へクロスフェード	実装済み（整列補償後の出力に対して）

  - HPF: 2次 Butterworth biquad、デフォルト 80Hz、Q=0.7071（`src/audio/hpf.ts`）。
  - AutoGain: targetRms 0.177(-15dBFS)、窓 50ms、attack 10ms / release 200ms、
    maxGain 4.0（`src/audio/auto-gain.ts`）。
  - Limiter: 閾値 -2dBFS、attack 0.5ms / release 30ms、4:1 ソフトニー、
    最終 ±1 クランプ（`src/audio/limiter.ts`）。

------------------------------------------------------------------------

      4. WASM・モデル仕様（確定: 外部 prebuilt 固定）

        4.1 モジュールと実サイズ

  モジュール	入手元	実サイズ	配布先
  DeepFilterNet3 (`df_bg.wasm`)	  DeepFilterNet `libDF`（wasm）ビルド（§4.3）	16.4MB (16,418,651B)。wasm-opt は効果なし（§4.3）	`public/wasm/df_bg.wasm`
  DFN3 モデル (`DeepFilterNet3_onnx.tar.gz`)	  上流 DeepFilterNet3（再梱包）	7.6MB (7,982,826B)	`public/models/`
  Silero VAD (`silero_vad.onnx`)	  上流配布（v5/v6, STFT+dw/pw conv）	2.2MB (2,273KB)	`public/models/`
  ONNX Runtime Web (`ort-wasm-simd-threaded.wasm`)	npm `onnxruntime-web` ^1.27.0	12.9MB (13,164KB)	`public/wasm/`
  同上 `.mjs`	  同上	23.6KB	`public/wasm/`
  合計	  -	  ≈ 38.4 MiB	-

  > v2 の「合計初回DL ~27MB」は誤り。実測合計は約 38–39MB。wasm-opt は本ビルドに
  > 効果がなく（§4.3）、削減は将来の自前ビルド（LTO 等）で検討する。

  > *追跡状態（重要）*: 上表のバイナリはすべて *git 管理下に置く*。旧 `.gitignore` の
  > `*.wasm` / `*.onnx` が `ort-wasm-simd-threaded.wasm` と `silero_vad.onnx` を
  > 除外していたため、クローンには df_bg.wasm とモデル tar しか含まれず、実機は
  > VAD / ORT 無しで起動していた（`bun test` はどちらも読まないので検知不能。§12）。
  > 該当行は削除済み。

        4.2 Silero VAD の WASM 化方針（継承）

  ONNX Runtime Web（`ort-wasm-simd-threaded.wasm`）を正式採用。C→WASM 路線
  （`wasm/silero-vad/`）は温存・ビルド対象外。

  |silero_vad.onnx
    → onnxruntime-web (WASM SIMD Threaded)
    → InferenceSession.create({ executionProviders:["wasm"] })
    → session.run({ input: f32[1,512], sr: i64[1], state: f32[2,1,128] })
        → { output: f32[1], stateN: f32[2,1,128] }|

  - 入力は 48kHz 1536 サンプル → *線形位相 FIR ローパス*（49 タップ Blackman,
    fc=7kHz）+ 3:1 デシメーションで 16kHz 512 サンプルへ（`src/audio/vad-engine.ts`）。
    実測: 通過帯域 ≈1.0、8kHz 以上 ≈0（エイリアス抑制）。

        4.3 DFN3 の調達・素性（調査で特定）

  *外部 prebuilt を固定採用*する（自前の Rust→wasm ビルドは非目標）。

  素性（実測で特定）:
  - 搭載 `df_bg.wasm` は *DeepFilterNet 公式 `libDF` クレート（`--features wasm`）を
    tract-onnx 0.23.3 でビルドした wasm*。wasm 内のビルドパスに
    `/home/vinhnp/.cargo/registry/.../tract-*-0.23.3` と `libDF/src/{lib,tract,wasm}.rs`
    が残存。producers: `rustc 1.93.1 (2026-02-11)` / `walrus 0.26.4` /
    `wasm-bindgen 0.2.126`。target_features: simd128 ほか有効。
  - ビルダー名 `vinhnp`（mezon コラボレータ `phuvinh010701` と推定）。
  - *mezon の CDN / npm 成果物ではない*（ハッシュ不一致。§4.5 参照）。mezon 版は
    `wasm-opt -O4` 済みで 9.2–9.6MB。本 wasm は *wasm-opt 未適用*（16.4MB）。
  - `src/audio/df.js`（wasm-bindgen glue）は *本 wasm と同一ビルドの生成物*
    （glue と wasm の import 名・ハッシュが一致）。→ glue/wasm は自己整合なペア。
  - モデルは *上流 DeepFilterNet3 ONNX*。mezon 版と `config.ini` が SHA 一致、
    ONNX のバイトサイズも一致。本リポジトリの tar はフラット構造に再梱包のみ。
  - *look-ahead 遅延*: deep-filter は `atten_lim>0` のとき出力を *3 フレーム
    （1440 samples, 30ms）* 遅延させる（`atten_lim=0` は bypass で遅延 0）。engine は
    末尾に 1440 ゼロを付加して処理し先頭 1440 を捨てる *pad+trim* で補償し、入出力を
    整列させる（実測 lag ≈0）。
  - *wasm-opt は無効*（実測）: `-O2/-O3/-O4` でサイズ削減は −2.5KB〜−35KB にとどまり、
    code セクション 14.67MB は不変。mezon 版 9.6MB はビルド設定（LTO 等）差が主因で、
    かつ ABI 非互換（import 名前空間が不一致）のため差し替え不可。→ 16.4MB を維持し、
    サイズ削減は将来の自前ビルド（LTO=thin / codegen-units=1 / panic=abort、16GB+）で
    検討する（現状は非目標）。
  - *ライセンス: MIT OR Apache-2.0*（DeepFilterNet 上流に準拠。mezon パッケージも
    同デュアル）。資産は緩許可で再配布可（著作権表示の保持が必要）。

  方針:
  - バイナリは *SHA-256 でピン留め*する（§4.5）。`df.js` も同時に管理。
  - `wasm/`（`lib.rs` は別 ABI スタブ）と `Dockerfile` は *削除する*（§14-12）。

        4.4 WASM-JS インターフェース（実装済み）

  |// src/audio/df.js（wasm-bindgen glue）
  df_create(model_bytes: Uint8Array, atten_lim: number): number;   // → handle
  df_get_frame_length(st: number): number;                          // → 480 @48kHz
  df_process_frame(st: number, input: Float32Array): Float32Array;  // 1 フレーム処理
  df_set_atten_lim(st: number, lim_db: number): void;
  df_set_post_filter_beta(st: number, beta: number): void;
  initSync({ module }): void;  // WebAssembly モジュール初期化|

  - `src/audio/dfn3-engine.ts` が `getDfn3Engine()` の遅延シングルトンとして
    ラップし、任意長 PCM を 480 サンプル単位で処理。
  - `reset()` は state を再生成（`df_create` を再実行）、`destroy()` は参照破棄
    （実装済み）。pipeline が各ファイル先頭で `reset()` を呼ぶ。

        4.5 資産ハッシュ（ピン留め / 2026-09 実測）

  資産	SHA-256	サイズ
  `public/wasm/df_bg.wasm`	  440B5D12B6EA7D95008736F844221D7874EE15DE5CB10D3015002470FDBA0432	16,418,651 B
  `src/audio/df.js`	  DB53EE40F42143A0077905F73C6255B272A651F36F451FCA6A2BDE980C749F71	-
  `public/models/DeepFilterNet3_onnx.tar.gz`	  CFB89FFCF908ABCE145E7A3CDDBD7C60F1687F73B743C0BDF85A3614C421B7DE	7,982,826 B
  `public/models/silero_vad.onnx`	  2623A2953F6FF3D2C1E61740C6CDB7168133479B267DFEF114A4A3CC5BDD788F	-
  `public/wasm/ort-wasm-simd-threaded.wasm`	  D1AB1B94B16A65B29D710D0B587B29E7BED336827577623913479B8AFE8113E6	13,164 KB
  `public/wasm/ort-wasm-simd-threaded.mjs`	  0A1E718D99C41B22C21F2520FF4F9E883A6B5533856E398D21816EE8EB8185D3	23.6 KB

  参考（*不一致*の確認用・採用しない）:
  - mezon CDN v1 `df_bg.wasm`: `6EA100532996AA0A07405FA2265E27337C351FE1CBDF63AC65886373484089C7`
    (9,235,331 B)
  - mezon CDN v2 `df_bg.wasm`: `E133417D08BEE384D8E60DE27EFA91DA3D858920ED800D4794D490A177300600`
    (9,622,975 B)
  - mezon モデル tar: `C94D91F70911001C946E0FABB4AA9ADC37045F45A03B56008CB0C8244CB63616`
    (7,983,136 B)

  > wasm-opt 適用後は `df_bg.wasm` のハッシュ・サイズが変わる。適用時に本書を更新。

------------------------------------------------------------------------

      5. PWA 仕様

        5.1 Service Worker キャッシュ戦略（`public/sw.js`）

  アセット	実サイズ	戦略
  `/wasm/df_bg.wasm`	  16.4MB	Cache-First（MODEL_CACHE）
  `/models/DeepFilterNet3_onnx.tar.gz`	  7.6MB	Cache-First（MODEL_CACHE）
  `/models/silero_vad.onnx`	  2.2MB	Cache-First（MODEL_CACHE）
  `/wasm/ort-wasm-simd-threaded.wasm`	  12.9MB	Cache-First（MODEL_CACHE）
  `/wasm/ort-wasm-simd-threaded.mjs`	  23.6KB	Cache-First（MODEL_CACHE）
  `*.js / *.css / *.wasm / *.json / *.png / *.svg / *.ico`	  -	Stale-While-Revalidate
  `/`, `/index.html`	  -	Network-First
  合計（モデル+WASM）	  ≈ 38.4 MiB	  -

  - `sw.js` のコメント「~27MB」は誤り → 実値（~38MB）へ更新済み。
  - モデル更新時は CACHE_NAME / MODEL_CACHE の bump が必要。
  - `public/_headers`: COOP/COEP 必須、CSP（`wasm-unsafe-eval` 許可）、
    `/models/*` は `immutable`。

        5.2 Web App Manifest（`public/manifest.json`）

  `name: VoiceDenoise` / `short_name: Denoise` / `display: standalone` /
  icons 192・512 / screenshots 1280x720 / `start_url: /`。

        5.3 オフライン動作

  機能	可否	備考
  音声ファイルのノイズ除去	✅	全処理クライアント完結
  モデル読み込み（初回）	❌	初回のみネットワーク必須（≈38MB）
  モデル読み込み（2回目以降）	✅	Service Worker キャッシュ
  UI 表示	✅	SW キャッシュ

------------------------------------------------------------------------

      6. UI/UX 仕様

        6.1 画面構成（`src/ui/app.ts`, `controls.ts`, `waveform.ts`, `splash.ts`）

  - ヘッダ: ロゴ「VoiceDenoise」。
  - 波形表示: 入力（上）/ 出力（下）、min/max 垂直線、RMS 比で発話区間（緑）
    /無音区間（暗灰）に色分け。
  - スプラッシュ: VAD モデルのロード完了（または 15 秒タイムアウト）まで表示。
  - エンジン選択（ラジオ）: スタンダード / 高品質。
  - パラメータ: VAD 感度 / リリース / ホールド / HPF / AGC ON-OFF /
    リミッター ON-OFF / 抑制強度（高品質時のみ表示）。
  - 操作: ファイル選択 / 処理開始（処理中は停止）/ 出力ダウンロード / 試聴 /
    出力-入力 A/B トグル。
  - *マイク入力 / 録音 ボタンは非目標（凍結）。UI からは非表示とする（確定）。*
    コードは温存する。
  - ステータスバー: 進捗バー + 残り時間。

        6.2 入出力形式（確定）

  モード	入力	出力	備考
  ファイル処理	`audio/*`（`decodeAudioData` 依存。WAV/MP3/OGG/FLAC/M4A 等）	*16-bit モノラル WAV*	`src/audio/encoder.ts`
  A/B 比較	同一 PCM	入力/出力を交互再生（試聴）	画面トグル

  > MP3/OGG/FLAC 出力は非目標。リアルタイム録音（WebM）も非目標。

------------------------------------------------------------------------

      7. 性能・品質目標（確定）

        7.1 品質目標（確定）

  - 仕様目標: PESQ ≥ 3.5 / STOI ≥ 0.95（DNS / DeepFilterNet の公称値に基づく）。
  - *実測（自前セット、STOI）*: snr10 で 0.90–0.92、snr0 で 0.84–0.89（mean 0.89）。
    合成ノイズ条件では目標 0.95 に未達 → *CI ゲートは回帰ベース*（§9.2、baseline ±
    許容差）とし、仕様目標は参考表示に留める。PESQ は CI(Linux) で計測。
  - 補助指標: 無音区間の残差ノイズ ≤ -60dBFS、発話区間の歪み THD ≤ 1%、
    クリックノイズなし（聴感 + 波形）。

        7.2 速度目標（実測記録）

  - *実測 RTF*（フルチェーン、`run_chain.ts` の `timing.json`）:
      - CI ubuntu-latest: one-shot 0.19 / steady 0.07（32s 音声、reset 366ms）。
      - ローカル Windows: one-shot 0.52 / steady 0.26（reset 718ms）。
  - 旧 RTF ≤ 0.05（i7-8700 1コア）は撤回。RTF はランナー差が大きいため *ゲート化せず
    記録のみ*（CI で計測・artifact 化）。
  - リアルタイムはスコープ外のため、レイテンシ予算（旧 §7.1）は削除。

        7.3 メモリ目標（確定）

  環境	上限	備考
  i7-8700 級デスクトップ	200MB	単一 target。NAT-VPS / Surface Go は撤回

------------------------------------------------------------------------

      8. ビルド・デプロイ（確定）

        8.1 リポジトリ構成（現状）

  |voice-denoise/
  ├── src/
  │   ├── audio/
  │   │   ├── pipeline.ts          # FilePipeline（standard / high_quality）
  │   │   ├── pipeline.worker.ts   # ファイル処理 Worker
  │   │   ├── pipeline-client.ts   # Worker ファサード + メインスレッドfallback
  │   │   ├── vad-engine.ts        # Silero VAD (ORT Web)
  │   │   ├── vad-gate.ts          # Noise Gate + VadSmoother
  │   │   ├── dfn3-engine.ts       # DFN3 wasm ローダ（Worker/メイン）
  │   │   ├── df.js                # wasm-bindgen glue（ベンダリング）
  │   │   ├── event-loop.ts        # ループからの yield（キャンセル/描画のため）
  │   │   ├── hpf.ts / auto-gain.ts / limiter.ts / post-eq.ts
  │   │   ├── decoder.ts / encoder.ts / player.ts
  │   │   ├── realtime.ts          # 【非目標・凍結】
  │   │   └── ring-buffer.ts       # 【非目標・凍結】
  │   ├── ui/  app.ts / controls.ts / waveform.ts / splash.ts
  │   ├── core/dom.ts
  │   ├── style.css
  │   └── main.ts
  ├── public/
  │   ├── audio/worklet-processor.js   # 【非目標・凍結】
  │   ├── sw.js / manifest.json / _headers / icon-*.png / screenshot.png
  │   ├── models/  silero_vad.onnx, DeepFilterNet3_onnx.tar.gz
  │   └── wasm/    df_bg.wasm, ort-wasm-simd-threaded.{wasm,mjs}
  ├── SPEC.md          # 本仕様（唯一の正）
  ├── scripts/build-static.ts, scripts/clean.ts
  ├── tools/  quality_gate.py, demo-smoke.ts,
  │           build-dfn3-wasm.{md,ps1},
  │           quality/{generate_fixtures.ts, run_chain.ts, fixtures/, sources/}
  ├── .github/workflows/ci.yml
  ├── wrangler.toml / package.json / tsconfig.json / vite.config.ts
  └── bunfig.toml|

        8.2 ビルド・実行コマンド（`package.json`）

  |bun install            # 依存導入
  bun run dev            # Vite 開発サーバ（COOP/COEP HMR）
  bun run build          # clean + build:bundle (bun build src/main.ts) + build:static
  bun run clean          # dist/ を削除（単体でも使える）
  bun run test           # bun test
  bun run typecheck      # tsc --noEmit
  bun run preview        # dist のローカルプレビュー（COOP/COEP 付き）|

  - `scripts/build-static.ts`: `public/` → `dist/` コピー、Worker ビルド、
    `index.html`/`main.js` パッチ、worklet への `df.js` インライン展開。
  - `build:dfn3` は削除済み（`wasm/` も削除）。
  - アプリのバージョンは *0.2.0 に統一*する（`package.json` / CHANGELOG /
    README。§14-11）。

        8.3 デプロイ（確定: Cloudflare Pages 一本化）

  - `wrangler.toml`（`pages_build_output_dir = "dist"`）+ `public/_headers` に
    一本化。Vercel / Netlify の設定は *削除する（確定）*。

        8.4 CI（`.github/workflows/ci.yml`）

  ジョブは `build`（`bun install` → `typecheck` → `test` → `build` → `dist` アップロード）
  と `quality`。`quality` は Python 3.11（`.python-version`）+ uv で
  `bun run tools/quality/run_chain.ts` → `uv run tools/quality_gate.py`（回帰ゲート、§9.2）。

------------------------------------------------------------------------

      9. テスト仕様

        9.1 自動テスト（現状）

  - 現状 *50 テスト / 12 ファイル / 全パス*、`tsc --noEmit` は 0 エラー。
  - 対象: `vad-gate`、`encoder`、`ring-buffer`、`limiter`、`hpf`、`auto-gain`、
    `pipeline.abort`、`pipeline.order`（チェーン順序）、`dfn3-wasm`（glue/モデルの整列）、
    `dfn3-engine`（engine の遅延補償 + 途中 abort）、`post-eq`、`vad-engine`（FIR デシメータ）。
  - 未カバー: `decoder`（Web Audio 依存）。

        9.2 品質テスト（確定: 自前セット + 回帰ゲート、CI）

  - *自前の固定セット*（`tools/quality/fixtures/`、実装済み）:
      - クリーン音声: CMU ARCTIC（16kHz WAV、MIT 相当ライセンス）を x3 アップサンプル
        して 48kHz 化（話者 bdl / slt / rms）。
      - ノイズ: 合成ピンクノイズ（固定 seed、権利不要）。
      - 固定 seed（0x5eed）で SNR 10 / 0 dB を混合 → 8 ペア（`*_clean.wav` /
        `*_noisy.wav`、48kHz mono 16-bit）。帰属と手順は
        `tools/quality/fixtures/ATTRIBUTION.md`、パラメータは `manifest.json`。
      - 生成: `bun run tools/quality/generate_fixtures.ts`。
  - *チェーン実行*: `bun run tools/quality/run_chain.ts` が各 noisy を `FilePipeline`
    （high_quality、ゲート無効、DFN3 注入）で処理し `tools/quality/out/` へ出力。ゲート
    （VAD）は侵襲指標を歪めるため対象外（DFN3 チェーン品質を測る）。
  - *ゲート*: `tools/quality_gate.py`。各 processed 対 clean で STOI/PESQ を計算し、
    *ベースライン（`tools/quality/baseline.json`）からの低下*が許容差（STOI 0.02 /
    PESQ 0.2）を超えたら CI を失敗させる（回帰検知）。`--update-baseline` で更新。
  - 仕様目標（PESQ ≥ 3.5 / STOI ≥ 0.95）は *参考表示*（本セットでは未達、§7.1）。
  - baseline は CI(Linux) 生成（`quality-baseline.yml`）。STOI はローカル Windows と
    一致を確認（プラットフォーム差なし）。PESQ（≈1.1–1.9）は CI のみで計測。
  - PESQ は Linux の wheel で CI 計測。ローカル Windows は `--skip-pesq`（pesq は
    MSVC 要）。CI の `quality` ジョブが計測する。

        9.3 対象ブラウザ（確定）

  Chrome / Edge を主対象（VAD と DFN3 は WebAssembly SIMD 前提）。Firefox は
  動作可。Safari は SAB 非依存のためファイル処理は可だが、実機検証は任意。

------------------------------------------------------------------------

      10. 実装状況まとめ

  Phase	内容	状態
  Phase 1	VAD + 基本 UI + ファイル入出力 + Noise Gate	✅ 実装済み
  Phase 2	DFN3 + パイプライン統合	✅ 実装済み（順序修正済み）。wasm は 16.4MB 維持
  Phase 3	PWA + Service Worker + オフライン	✅ 実装済み
  Phase 4	リアルタイム + A/B 比較	⊘ 非目標（凍結温存）。A/B 比較のみ継続
  Phase 5	品質チューニング + テスト + ドキュメント	✅ 品質セット・回帰ゲート・CI baseline・RTF 計測 実装済み（残: decoder テスト）

  - 目標達成に必要な残作業: ①残テスト（decoder）。（DFN3 wasm の削減は将来の自前ビルドで検討）

------------------------------------------------------------------------

      11. リスクと対策

  リスク	影響	対策（確定方針）
  DFN3 の wasm が単一ビルド由来	更新・再取得が困難	ハッシュ固定（§4.5）+ 出所記録（§4.3）
  DFN3 の速度が実用外	処理時間が長い	実測で許容範囲を確認（wasm-opt は効果なし）
  48kHz 非対応入力	品質劣化	decodeAudioData で 48kHz へリサンプリング

------------------------------------------------------------------------

      12. 既知課題

  ・実装済み（v7–v10 で対応）
   - *チェーン順序*: `Gate → HPF → DFN3 → PostEQ → AGC → Limiter` に組替
     （`pipeline.ts` の段構成化）。
   - *DFN3 遅延補償*: deep-filter は atten>0 で出力を 3 フレーム（1440 samples, 30ms）
     遅延させる（atten=0 は bypass）。engine が pad+trim で補償し整列（実測 lag≈0、
     STOI 0.79→0.875 @0dB）。
   - *オフライン DFN3 の warmup*: 整列補償後の出力に対し、先頭 `fl*3`(1440) サンプルを
     等功率で入力→DFN 出力へクロスフェード。
   - *`Dfn3Engine.reset()`*: state を再生成（`df_create` 再実行）。pipeline が各
     ファイル先頭で呼ぶ。`destroy()` は参照破棄。
   - *出所コメント*: `dfn3-engine.ts` を §4.3 の内容へ修正。
   - *§12-2（atten_lim）は誤指摘*: `atten_lim` は「最大減衰量 dB」(0=低減なし /
     100=最大低減) で、抑制強度% の線形マッピングは正しい。コード変更なし。
   - *VAD ダウンサンプル*: 1 次 IIR を *49 タップ線形位相 FIR（Blackman, fc=7kHz）+
     3:1 デシメーション*に置換（実測で 8kHz 以上 ≈0）。
   - *ドキュメント/不要物*: `package.json`=0.2.0、`sw.js` のサイズ表記を実値化、
     README を要約化（正は `SPEC.md`）。`wasm/` / `Dockerfile` / 旧 `dfn3.wasm` /
     `dist-worker/` / `demo-output.wav` / `demo-real.wav` を削除。
   - *品質ゲート（W5）*: 自前セット（CMU ARCTIC + 合成ノイズ、8 ペア）+ チェーン
     ハーネス + 回帰ベースの CI ゲート（§9.2）。STOI 実測 mean 0.89。

  ・残（目標達成に必要）
   1. *テスト未カバー*: `decoder`（Web Audio 依存）。`vad-engine` は追加済み。
   2. *DFN3 wasm のサイズ*: 16.4MB を維持（wasm-opt は無効と実測、§4.3）。削減は
      将来の自前ビルド（LTO 等）で検討（§15）。
   3. *CI がアセット欠落を検知できない*: `silero_vad.onnx` / `ort-wasm-simd-threaded.wasm`
      は `.gitignore` の `*.onnx` / `*.wasm` で除外され *未追跡*（§4.1 の一覧には
      載っているが、クローンには含まれない）。クリーンチェックアウトではこれらが
      無いため、実機は VAD 無し・ORT 無しで動く（`bun test` はどちらも読まないので
      緑のまま）。→ `.gitignore` の該当 2 行を削除し *追跡対象に追加*（解決）。
      なお wasm/モデルを更新したときは §5.1 の M-1 ルール（`CACHE_NAME` /
      `MODEL_CACHE` の bump）を忘れないこと。
   4. *Worker のキャンセルが効かない*: `pipeline-client.ts` は abort で Promise を
      reject するだけで Worker に通知せず、Worker は DFN3 を含む全処理を最後まで
      実行し続けていた（=`停止` ボタンは見た目上戻るが計算は継続）。→ *解決*。
      `cancel` メッセージ + `AbortController`（worker）→ `signal` を DFN3 の
      フレームループまで伝播、で実際に中断する。実測: 60 秒音声の高品質処理を
      開始 3 秒後に停止 → UI 反映 517ms、10 秒音声のエンジン単体では
      1225ms → 249ms（80% 短縮）。
      *注意*: キャンセルが届く条件は「ループが実際にイベントループへ譲歩している」
      こと。譲歩を `MessageChannel` で行うと *タイマー/メッセージのタスクソースが
      飢餓*し、timer 起点の abort が DFN3 完走後にしか届かない（実測で再現）。
      `event-loop.ts` はそのため `setTimeout` ベースにしてある。ここを
      MessageChannel に戻してはいけない。
   5. *進捗メッセージが過多*: `runVadGate` が 1536 サンプル窓ごとに 1 件 emit する
      ため、10 分の音声で約 18,000 件の postMessage が発生していた。→ *解決*。
      約 100ms 間隔に間引き（最終窓は必ず emit）。
   6. *`tools/quality_test.py` は未参照*: 117 行。`quality_gate.py`（回帰ゲート、
      baseline 対応、CI 接続済み）に役割を譲っており、SPEC のディレクトリ一覧以外から
      参照されていない。フィクスチャが揃った現在は到達不能。→ *削除済み*。

  ・回帰修正（レビューで発見・修正済み）
   - *dev/preview で DFN3 が黙って死んでいた*: Vite の静的配信（sirv）は
     *ファイル名が `.gz` で終わる*という理由だけで `Content-Encoding: gzip` を
     付けていた。`/models/DeepFilterNet3_onnx.tar.gz` は実際に gzip 済みで
     `df_create` にそのまま渡す必要があるため、ブラウザが透過的に解凍して
     *解凍済み tar* を wasm に渡し、`unreachable` でトラップ →
     `getDfn3Engine()` が null を返し *スタンダード品質へ無言フォールバック*していた。
     `run_chain.ts` / `bun test` はディスクから直接読むため検知できなかった。
     対策: `vite.config.ts` の `servePublicAssets()` が `/models/*.tar.gz` と
     `/wasm/*.{mjs,wasm}` を `Content-Encoding: identity` + 実バイト数の
     `Content-Length` で配信する（`configureServer` と `configurePreviewServer` の
     両方）。本番（Cloudflare Pages / 素の静的ホスト）は元から無改変で配信するため、
     これは dev/preview を本番に揃えるだけ。実測: hq RMS 0.138 vs standard 0.177、
     平均絶対差 0.065（DFN3 が実際に効いている）。
   - *`hidden` 属性が効いていなかった*: `.btn { display: inline-flex }` 等の
     クラス規則が `hidden` 属性に勝つため、`el.hidden = true` が無効化されていた
     （再生/出力ボタンも常時表示だった）。`src/style.css` に
     `[hidden] { display: none !important; }` を追加して修正。マイク/録音ボタンは
     §6.1 のとおり非表示になった。

  ・非目標（凍結対象）の既知課題（再開時に扱う）
  - リアルタイム VAD の時間整合（メインスレッド非同期推論）。
  - worklet のキュー実装（`Array.shift()` をサンプル毎）。
  - DSP の二重実装（HPF/AGC/Limiter が TS と worklet に重複）。

------------------------------------------------------------------------

      13. 参考実装・ソース

  番号	リソース	URL	用途
  [1]	DeepFilterNet (Rikorose)	github.com/Rikorose/DeepFilterNet	DFN3 本体・`libDF` wasm・モデル
  [2]	Silero VAD	snakers4/silero-vad	VAD モデル
  [3]	ONNX Runtime Web	microsoft/onnxruntime	VAD 推論
  [4]	mezonai/mezon-noise-suppression	github.com/mezonai/mezon-noise-suppression	同系統の配布（本成果物は別ビルド。§4.3）
  [5]	tract-onnx 0.23.3	github.com/sonos/tract	`libDF` wasm の推論ランタイム
  [6]	boredland/noise	github.com/boredland/noise	DFN3 WASM + SW キャッシュの先行実装
  [7]	WorkAdventure (DTLN + LiteRT.js)	workadventu.re/tech/...	AudioWorklet + WASM 参考（凍結）
  [8]	DNS Challenge 2023	github.com/microsoft/DNS-Challenge	品質データセット（*不採用*。§14-3）

  > [4] は同系統だが、搭載 wasm は本リポジトリのビルド（§4.3）とハッシュ不一致。

------------------------------------------------------------------------

      14. 確定事項（決定ログ）

   1. *DFN3 調達*: 外部 prebuilt を固定採用。自前ビルドは非目標。出所（§4.3）・
      ライセンス・ハッシュ（§4.5）を記録。
   2. *リアルタイム*: スコープ外（凍結温存、将来再開前提）。コードは削除せず
      「非目標・実験的」と明示。
   3. *品質データセット/ゲート*: *自前の固定セット*（CMU ARCTIC クリーン + 合成
      ピンクノイズ、固定 seed、8 ペア）を同梱。ゲートは *回帰ベース*（baseline ± 許容差）
      とし、仕様目標（PESQ ≥ 3.5 / STOI ≥ 0.95）は参考表示（本セットでは未達）。
      *DNS Challenge 2023 は採用しない*（dev testset にクリーン参照が無く PESQ/STOI が
      計算不能、約 1TB、ライセンス混在のため）。
   4. *信号チェーン*: `Gate → HPF → DFN3 → PostEQ → AGC → Limiter`（実装済み）。
   5. *出力形式*: 16-bit モノラル WAV のみ。
   6. *対応環境*: i7-8700 級デスクトップ一本化。メモリ上限 200MB。
      NAT-VPS / Surface Go 目標は撤回。
   7. *速度目標*: 実測してから閾値を設定（CI 回帰）。
   8. *ドキュメント*: 本書を唯一の正。README / CHANGELOG / sw.js は要約 + リンク。
   9. *配布先*: Cloudflare Pages に一本化。
  10. *スタンダードモード*: 残す（フォールバック/プレビュー用途）。
  11. *アプリのバージョン*: 0.2.0 に統一（`package.json` / CHANGELOG / README）。
  12. *削除範囲*: `wasm/` / `Dockerfile` / Vercel・Netlify 設定 / 旧 `dfn3.wasm`
      をすべて削除する。
  13. *マイク/録音 UI*: 非表示にする（コードは凍結温存）。
  14. *DFN3 wasm のサイズ*: wasm-opt は無効と実測（`-O2/-O3/-O4` でほぼ不変）。
      16.4MB の現行ビルド（ハッシュ固定済み）を維持する。削減は将来の自前ビルド
      （LTO=thin / codegen-units=1 / panic=abort、16GB+）で検討する（現状は非目標）。

------------------------------------------------------------------------

      15. 残余未決

   1. *DFN3 の正式配布 URL*: 本ビルド（§4.3）の一次配布元の特定（任意）。
   2. *DFN3 サイズ削減*: 自前ビルド（LTO, 16GB+）の手順と補助スクリプトを用意済み
      （`tools/build-dfn3-wasm.md` / `.ps1`）。実行は 32GB 機 or larger runner で。
