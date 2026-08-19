# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 1. プロジェクト概要

StarGantt — 依存ライブラリゼロのプラグイン型ガントチャートライブラリ(pnpm + vite + TypeScript)。構成は **極小コア + SDK + 公式プラグイン15個**。コアはガントの概念(タスク・日付・描画)を一切知らず、公式機能はサードパーティと同じ公開APIだけで実装する(裏口API禁止)。

### 公式プラグイン15個(ディレクトリ名 / プラグインID)

| dir 名 | プラグインID |
|---|---|
| data-store | `stargantt.data-store` |
| view | `stargantt.view` |
| tree-grid | `stargantt.tree-grid` |
| task-bars | `stargantt.task-bars` |
| interaction | `stargantt.interaction` |
| undo-redo | `stargantt.undo-redo` |
| a11y | `stargantt.a11y` |
| scheduling | `stargantt.scheduling` |
| tracking | `stargantt.tracking` |
| resource | `stargantt.resource` |
| export | `stargantt.export` |
| data-sync | `stargantt.data-sync` |
| portfolio | `stargantt.portfolio` |
| i18n | `stargantt.i18n` |
| perf-tools | `stargantt.perf-tools` |

### パッケージ構成

- npm 名: `@stargantt/core`, `@stargantt/sdk`, `@stargantt/plugin-<dir名>`(例: `@stargantt/plugin-data-store`)、`@stargantt/preset-standard`(9プラグイン構成)、`stargantt`(全15プラグイン入りバンドル。tracking/resource/data-sync/portfolio/i18n/perf-tools はオプトイン)。
- パッケージ配置: `packages/core/`, `packages/sdk/`, `packages/plugins/<15名>/`(フラット配置・分類サブフォルダなし)、`packages/preset-standard/`, `packages/stargantt/`。

## 2. 正本ポインタ(単一の真実源)

- **仕様**: `docs/specs/` — `architecture.md` + `sdk.md` + `plugins/<name>.md`(15枚)。実装はこの仕様が唯一の指示源。仕様が沈黙している箇所は、テストで固定された現行実装の挙動が正。
- **ユーザー向けドキュメント**: `user-docs/`(独立サブパッケージ。自前の install/build/test/generate を `user-docs/README.md` に従って実行)。ドキュメント執筆中に見つけたライブラリ不具合は `user-docs-bug-findings/` に起票する(`user-docs/docs-policy.md` D-12)。

## 3. 絶対制約

- **実行時依存ゼロ**: `dependencies` に外部パッケージ禁止。外部パッケージは devDependencies のみ可。`@stargantt/*` のワークスペース内相互依存はライブラリ自身の構成要素であり対象外(バンドルに内包され、利用者に外部依存を強いない)。
- **リソースは必ず `ctx.own()` 経由**: リスナー・DOM・タイマー等はすべて `ctx.own()` で登録し、コアが破棄を所有する。
- **配布は IIFE + ESM の併存**(CSS は JS に埋め込み)。利用者は HTML 1枚 + script タグ1本で完結できること。
- **ビューポート前提: 横 720px × 縦 540px 以上**(タブレット以上)。モバイル(スマホ)向けレイアウト・720px 未満のブレークポイントは作らない。
- **コアは minify 後 12KB 以下**(CI ゲートで機械的に強制)。

## 4. 公用語

- **コード(コメント・文字列)・テスト・E2E・仕様書(`docs/specs/` 配下全部)・コミットメッセージは英語**。
- 例外: 本ファイル(CLAUDE.md)のみ日本語で可。

## 5. コマンド

pnpm workspace モノレポ。テストは vitest(ユニット)+ Playwright(E2E・スクリーンショット・性能回帰)。

```bash
pnpm install
pnpm run build              # vite library mode(ESM + IIFE を packages/stargantt/dist/ へ)
pnpm run test               # vitest(ユニット)
pnpm run typecheck          # tsc 型チェック
pnpm run lint:arch          # アーキテクチャ検査: 依存方向 + 公式イベントカタログ + コアサイズ(12KB)
pnpm run test:e2e           # Playwright E2E(要: 事前に pnpm run build。pinned コンテナ内で実行 — 下記参照)
pnpm vitest run <file>      # 単一テストファイル
pnpm exec tsc -p e2e --noEmit  # E2E コードの型チェック
```

- **E2E はコンテナ内実行が正**: `pnpm run test:e2e` は `tools/e2e-in-container.sh` 経由で公式 Playwright イメージ(タグはインストール済み `@playwright/test` バージョンから自動導出、例 `mcr.microsoft.com/playwright:v1.62.1-noble`)内で実行される。ホスト OS(Debian devcontainer / Ubuntu CI)のフォント差によるスクリーンショット乖離を防ぐため。ローカル・CI とも同一経路。ホスト直実行(`pnpm exec playwright test`)はデバッグ用の逃げ道であり、その結果のスクリーンショット比較は非公式 — 基準画像更新は絶対にホストで行わない。
- **OA スイープ**(組合せ探索、通常 CI 外): 手順・水準設計ルール・既知非不具合は `e2e/oa/CLAUDE.md` が正本。`playwright.config.ts` は `testIgnore: "oa/**"` — OA は専用 config(`e2e/oa/playwright.oa.config.ts`)で `OA_RUNS=...` を指定して実行する。
- **性能回帰**: `e2e/perf-regression.spec.ts` + `e2e/perf-10k.spec.ts`。assert は CI ノイズ対策で意図的に緩い(実測値はログ出力を見る)。
- **examples/**: 47ページ + `index.html` カタログ。`basic/interaction/scheduling/tracking/resource/data-sync.html` の6枚は E2E が DOM 契約(id・ボタン・`window.gantt` / `window.__lastOp`)に依存 — 変更時は対応する E2E を必ず確認する。

## 6. テストの注意点

- **E2E は必ずビルド後に実行**: E2E はビルド済みバンドル(dist)を対象にする。ソース変更後にビルドし忘れると、古い dist に対する**偽グリーン/偽レッド**になる。`pnpm run build` → `pnpm run test:e2e` の順を厳守。
- **基準画像の再生成は必ず `--update-snapshots=all`**: 既定の `changed` モードは「テストが失敗した」基準画像しか書き換えない。`maxDiffPixelRatio` 内に収まる本物の描画変更は基準画像が古いまま残り、以後ずっと緑のまま実際の描画と乖離する(ヘッダ桁ズレがこの経路で長期間見逃された前例がある)。`changed` モードは使用禁止(`tools/e2e-in-container.sh` が機械的に拒否する)。実行例: `pnpm run test:e2e --update-snapshots=all`。
- **スクリーンショットの緑は「壊れていない」証拠であって「直った」証拠ではない**: 見た目の修正を検証するときは、基準画像の比較だけで済ませず、実ブラウザで DOM 計測するか画像を目視すること。
- **vitest はワークスペース依存の dist を読む**: 依存パッケージ(例: `@stargantt/core`, `@stargantt/sdk`)を変更した後は、`pnpm run build` してからテストを実行すること。古い dist を掴んだテストは偽の結果を返す。
- **フルスイートは数秒で終わる**: 数分かかったらハングを疑う。テストのタイムアウトは30秒に設定し、異常を早期検知する。
- **スクリーンショット基準画像は pinned コンテナ内・x86_64 でのみ生成**: 「Linux ならよい」ではない(Debian と Ubuntu でフォントパッケージが異なり 0.002 許容を超えた前例あり)。生成・コミットは必ず `pnpm run test:e2e --update-snapshots=all`(= pinned イメージ内)で行う。x86_64 以外(Apple Silicon 等)では基準画像生成をラッパーが拒否し、スクリーンショット比較自体も自動スキップされる(`STARGANTT_SKIP_VISUAL=1`)— arm 上の visual 合否は CI に委ねる。Playwright バージョンを上げたらイメージも変わるため、その PR で基準画像を全再生成する。
- **E2E の並列実行はポート分離**: 複数エージェントが E2E を同時実行するときは `STARGANTT_E2E_PORT` でポートを分ける。
- **CI リトライは不安定テストを隠す**: `retries` 付きの緑は「flaky 0 件」の行まで確認する。安定性の検証は `--retries=0 --workers=1` で同一ファイルを3回連続実行。既知の不安定要因はドラッグ閾値未達(`mouse.move` に `{ steps }`)、フレーム遅延の再レイアウト読み(settle + 対象値のポーリング)、ブート/スクロール直後の bar box 読み(2フレーム連続一致まで待つ)。
- **欠落基準画像 + CI リトライ = 偽グリーン**: 基準画像が無いと初回試行が actual を書き、リトライがそれに対して合格する。新規スクリーンショットは必ず `--retries=0` で初回状態を確認する。

## 7. マルチエージェント開発の運用規約

大きめの変更をエージェント並列で回すときの規約。モデル/effort をユーザーが指定した場合は厳守。

### モデル/effort の割当(必須)

- **サブエージェントを起動するときは、必ずモデルと effort の両方を明示的に指定する**(省略・既定値任せ禁止)。
- **haiku はどの用途にも使用しない。**
- **fable は原則 effort=low で使用する。** medium 以上は、よほど難しいタスクでない限り使わない。
- ユーザー指定がない場合は次の目安に従う:

| タスク種別 | モデル | effort |
|---|---|---|
| 探索・調査(コード検索/読み取り) | sonnet | low |
| 機械的一括変更(rename/移動/スクリプト適用) | sonnet | low |
| 通常実装(1パッケージ規模) | sonnet | medium |
| 難しい実装(描画/スケジューラ/性能) | opus | medium |
| レビュー(実装と別モデル) | opus | low |
| 仕様書・設計文書の起草 | fable | low |
| 最難関(設計分岐の裁定案/難航デバッグ) | fable | low(真に必要な時のみ medium) |

### 実装→レビューのループ(必須)

- レビュアーは**実装に使ったモデル以外**、effort=low(既定は opus。haiku は全用途で使用禁止)。
- blocker/major がゼロになるまで「修正→再レビュー」を繰り返す。解消しない指摘は列挙して親(オーケストレーター)へ返し、親が裁定または人間へエスカレートする。
- レビューは git diff を対象範囲と仕様に突き合わせ、テストを**自分でも実行**して検証する。カバレッジ指摘は mutation probe(実装を一時改変してテストが落ちることを確認 → 完全復元)で実証する。

### 検証ゲートとコミット

- 各ワークフロー完了時に親(オーケストレーター)が必ず**自分で**検証ゲートを再実行する:
  `pnpm run build` → `pnpm run test` → `pnpm run typecheck` → `pnpm run lint:arch` → `pnpm exec tsc -p e2e --noEmit` → `pnpm run test:e2e`。
  エージェントの「全パス」報告を鵜呑みにしない(偽グリーンの典型: 古いビルド済み dist を掴んだテスト、CI リトライに隠れた不安定テスト、並行編集による見逃し)。
- git commit/push はワークフロー完了ごとに親が行う。**サブエージェントには commit/push・スナップショット基準画像の更新をさせない。**
- 並行エージェントがルートの build/test を同時実行すると dist 書き込みが競合する — ルートコマンドは `flock` で直列化する。

### サブエージェント運用の注意

- プロンプトに「サンドボックス失敗時は dangerouslyDisableSandbox で再実行せよ」等の**サンドボックス回避指示を書かない**(安全分類器にブロックされ全エージェントが起動失敗する)。
- 移動・分割・リネーム系の**機械的作業に内容の修正を混ぜない**。作業中に見つけた仕様とソースの乖離は**報告のみ**とし、監査リスト化 → ユーザー裁定 → 仕様改訂 or 実装修正の別サイクルで扱う。
- lint 検査の回避(`ctx.use`/`ctx.useOptional` のエイリアス化・`.bind` 隠蔽)は、エッジが合法でも監査痕跡を壊すため禁止。未型付けサービスの参照は可視シム(`function lookupX(ctx: { useOptional(key: string): unknown })` がリテラルに `ctx.useOptional("...")` を呼ぶ形。キャストは引数側のみ)で書く。

## 8. UI/UX スキル(必須)

- **ガントチャートのコード(描画・対話・レイアウト・色・タイミング・a11y に影響する変更)を編集・レビュー・設計するときは、必ず `gantt-ui-ux` スキル(`.claude/skills/gantt-ui-ux/`)を使用する。** 該当領域の `references/*.md` を実装前に読み、SKILL.md の Pre-Ship Checklist を完了報告前に実行する。
- サブエージェントへ UI 関連タスクを委譲するときも、プロンプトにこのスキルの使用を明示する。
