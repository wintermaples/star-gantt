# CLAUDE.md — user-docs

このディレクトリは StarGantt の**利用者向けドキュメントサイト**。ライブラリ本体とは別のアプリで、
別の pnpm ルートを持つ。ライブラリのコードを変更する作業ではここを読む必要はない。

裁定台帳は [`docs-policy.md`](./docs-policy.md)（**D-nn**）。ライブラリ公開API契約のコーパス
とは番号系が別で、混ぜない（D-01）。

## 絶対制約

1. **ライブラリのワークスペースに入れない。** `user-docs/pnpm-workspace.yaml` が独自ルート。
   React / CodeMirror / Vite はこのサイトの依存であって、ライブラリの runtime 依存ではない。
   ルート CLAUDE.md の「サードパーティ実行時依存ゼロ」を汚さないための物理的な分離（D-02）。
2. **裏口を使わない。** チャートは出荷バンドル `packages/stargantt/dist/stargantt.js` を
   公開 `create()` で mount する。ドキュメント専用の API・内部 import・パッチを作らない。
   サイトで動く例は、読者のプロジェクトでもそのまま動く（D-03）。
3. **欠落は見えるようにする。** 未執筆のページはナビから消さず `todo` を出す。
   ページの無いプラグインが1つでもあればテストが名指しで落ちる。猶予枠は無い
   （`docs-debt.json` は債務ゼロ到達時に D-04 どおり削除済み）。
4. **生成物は手で書かない。** プラグインID・依存・config の名前と型・service /
   event / command / 拡張ポイントのキーと署名は `src/generated/api.json` から来る。
   CSS トークン（名前・light/dark 値・読むプラグイン・canvas 読み・forced-colors 対応）は
   `src/generated/tokens.json` から来る。これらを手編集した瞬間にテストが落ちる（D-05・D-24）。
5. **本文は英語。** ソース・仕様書・examples と同じ英語規約を適用する。
   例外はこのファイルのみ（D-06）。
6. **ビューポート下限 720×540。** これ未満のレイアウト・ブレークポイントを作らない
   （ルート CLAUDE.md の UI/UX 制約と同じ）。UI に触るときは `gantt-ui-ux` スキルを使う。

## 構成

```
tools/extract-api.ts     TS Compiler API でライブラリのソースを走査 → api.json
tools/extract-tokens.ts  styles/tokens.css + styles/layout.css + view プラグインの theme 内部
                         モジュール → tokens.json（theme.md 相当の外部台帳は無い。
                         stylesheet 自体が正本）
tools/build-content-index.ts content モジュールを import → manifest + search-index
src/generated/api.json   生成物。コミットする。差分でテストが落ちる
src/generated/tokens.json 生成物。全 --sg-* トークン。ライブラリ全ソース走査で漏れがあれば
                         生成器自体が書き込みを拒否する（D-24）
src/generated/content-manifest.json 各ページの slug/title/モジュール。ナビと router はこれだけ読む（D-16）
src/generated/search-index.json  識別子+一行要約。初回検索時だけ取得する別チャンク（D-15）
src/lib/search.ts        検索スコアリング。ライブラリ非使用（camelCase 分割が要るため）
src/lib/theme.ts         light/dark/OS追従 の切替と購読。GanttPreview が購読して
                         各チャートの theme.refresh() を呼ぶ（D-18）
src/lib/printSpec.ts     DemoSpec → 読者が書く形。printCall() は runnable セル下の
                         「the call this makes」ペインの中身（D-21）
src/components/StaticCode.tsx 読者がコピーするリスト。読取専用の CodeMirror（D-20）
src/content/types.ts     執筆者が書く型（PluginDoc / GuideDoc / CoreDoc / DemoSpec）
src/content/plugins/<分類>/<name>.ts   1プラグイン1モジュール
src/content/guides/NN-<slug>.ts        ガイド1本1モジュール
src/content/core/NN-<slug>.ts          core 1章1モジュール
src/content/registry.ts  import.meta.glob（**非 eager**）。手書きの一覧は無い。eager glob を
                         src/ に置くと全ページがバンドルに戻る（D-16）。テスト用の eager 版は
                         test/_all-content.ts
src/pages/               レイアウト3種。ページごとの実装は書かない
test/_all-content.ts     全 content モジュールの eager import（テスト専用）
test/coverage.test.ts    網羅性・整合性の強制（vitest）
e2e/pages.spec.ts        全ページの実行検査（Playwright、基準画像なし）
```

## コマンド

```bash
# 前提: リポジトリルートで pnpm run build（サイトは dist を読む。古いと嘘を書く）
pnpm install
pnpm run generate      # api.json + tokens.json + search-index.json 再生成
pnpm run dev           # http://localhost:5175
pnpm run test          # vitest（網羅性）
pnpm run test:e2e      # Playwright（要 build）
pnpm run typecheck     # src + e2e
pnpm run build
```

リポジトリルートからも叩ける: `pnpm run test:docs` / `test:docs:e2e` / `typecheck:docs` /
`docs:generate`。

## ページを書くときの規則

- **散文中のコードは `` ` `` で囲む**（D-19）。唯一のマークアップ。`RichText` が `<code>` に描画する
  （guides・reference・callout・caption・生成 TSDoc すべて）。太字もリンクも無い。閉じ忘れは
  ただのバックティック。**slug / title / route / プラグインid には絶対に入れない**（テストが落ちる）。
  文章ではなくリスト全体を見せる場所は guides の `kind: "code"` セル（実行されない・言語ラベル付き）。
- **静的なリストは `StaticCode`**（読取専用 CodeMirror）。`<pre class="code">` を新しく書かない。
  言語は code セルのガターラベル（`ts` / `html` / `css`）が決める（D-20）。
- **guides は平易に、reference は詳細に**（D-17）。guides は短文・二人称・1文1論点で
  「どう使うか」だけを書く。設計理由・カーネルの保証・API の細かい許容範囲は core 章と
  reference ページに置き、guides からはリンクする。reference / config ページの密度は現状維持。
- **ページに出す情報は読者が使えるものだけ**（D-18）。生成元メタ（⚙/✎）・ドキュメント化率・
  プラグイン数/オプション数・タブの件数・opt-in バッジは置かない。preset 所属は各ページの
  Installing it のコードで伝える。色だけで意味を伝えない。
- **1プラグイン = 2ページ**（タブ式リファレンス + Config 詳細）。分割も統合もしない（D-07）。
- `PluginDoc.properties` は `api.json` の config と**完全一致**。多くても少なくても落ちる。
- **CSS トークンページ（`/tokens`）**: 行は生成物。手で書くのは `src/content/tokens.ts` の
  導入文・各セクション・**グループごとの説明文**だけ。`tokens.json` のグループ id 全部に
  title と prose が要る（無いとテストが名指しで落ちる）。新トークンが増えたら
  `node tools/extract-tokens.ts` → 新グループができていれば説明文を書く（D-24）。
- 各プロパティは `demo: { kind: "values", values: [...] }` を持つ。
  - `values[0]` は**そのプラグインのデフォルト**で、何も設定しない（空の `demo: {}`）。
  - 前提設定が要るオプション（`labelPlacement` には `label` provider が要る）は
    `prerequisite` に分ける。`values[0]` に混ぜるとページ全体の基準チャートが汚れる（D-08）。
  - 視覚差が出ないオプションは `demo: { kind: "none", reason }`。**reason は必須**で、
    40文字未満だとテストが落ちる。「なぜデモできないか」を書く（D-09）。
- `prose` は**最低2段落**、各段落40文字超。生成された TSDoc は同じページに
  折り畳みで並ぶので、**言い換えを書かない**。書くのは「いつ使うか」「何を損なうか」
  「他と何が干渉するか」（D-10）。
- 空の API 面（events 0件など）は `notes.<kind>.__empty` に理由を書く。省略は不可（D-11）。

## バグを見つけたら

ドキュメントを書いている最中にライブラリの不具合（動かない・契約と挙動が違う・
例が再現しない）を見つけたら、**直さない**。`user-docs-bug-findings/` に HTML の
レポートを1件1ファイルで作る（`user-docs-bug-findings/README.md` に雛形と規則）。
修正は別サイクルで人間が裁定する（D-12）。
