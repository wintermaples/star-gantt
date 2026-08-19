# StarGantt

**「基本機能すらプラグイン」のガントチャートライブラリ — 実行時依存ゼロ。**

[ドキュメント](https://wintermaples.github.io/star-gantt/) ·
[ライブデモ](https://wintermaples.github.io/star-gantt/examples/)

> 本ファイルは日本語訳です。正文(canonical)は [README.md](./README.md)(英語)。内容が食い違う場合は英語版が優先されます。

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Core: <12KB min](https://img.shields.io/badge/core-%3C12KB%20min-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

StarGantt はウィジェットではなく VS Code のように作られています。タスクも日付も描画も知らない **12 KB 未満(minify 後)のマイクロカーネル**と、それ以外のすべて — 描画、ドラッグ編集、依存関係、自動スケジューリング、クリティカルパス、ベースラインと EVM、リソース管理、入出力、外部データ同期 — を実装する **15 個の公式プラグイン**。公式プラグインが使うのは、あなたのプラグインと同じ公開 API だけです。組み込みの挙動が気に入らなければ、プラグインごと置き換えてください。

## クイックスタート

```html
<div id="chart" style="height: 480px"></div>
<script src="stargantt.iife.js"></script>
<script>
  const gantt = StarGantt.create({
    element: document.getElementById("chart"),
    plugins: StarGantt.presetStandard(),
  });

  const day = 86400000;
  const t0 = Math.floor(Date.now() / day) * day;
  gantt.service("stargantt.data").load({
    tasks: [
      { id: "root", parentId: null, name: "Release prep", type: "summary", start: t0, end: t0 + 20 * day },
      { id: "spec", parentId: "root", name: "Design", start: t0, end: t0 + 5 * day, progress: 1 },
      { id: "impl", parentId: "root", name: "Implementation", start: t0 + 5 * day, end: t0 + 15 * day, progress: 0.4 },
      { id: "qa", parentId: "root", name: "Verification", start: t0 + 15 * day, end: t0 + 20 * day },
      { id: "ship", parentId: "root", name: "Release", type: "milestone", start: t0 + 20 * day, end: t0 + 20 * day },
    ],
    links: [
      { id: "l1", sourceId: "spec", targetId: "impl", type: "FS" },
      { id: "l2", sourceId: "impl", targetId: "qa", type: "FS" },
      { id: "l3", sourceId: "qa", targetId: "ship", type: "FS" },
    ],
  });
</script>
```

これで完結したアプリケーションです: **HTML 1枚 + script タグ 1本**。スタイルは `create()` が注入します。バンドラーを使う場合:

```ts
import { create, presetStandard } from "stargantt";

const gantt = create({
  element: document.getElementById("chart")!,
  plugins: presetStandard(), // PresetStandardConfig で各プラグインを設定可能
});
gantt.service("stargantt.data").load({ tasks, links }); // 完全に型付け
```

オプトインの 6 プラグインは、ファクトリを `plugins` に足すだけで有効になります:

```ts
import { create, presetStandard, tracking, resource } from "stargantt";

const gantt = create({
  element,
  plugins: [...presetStandard(), tracking({ baselines: {} }), resource()],
});
```

## インストール

```bash
npm install stargantt          # 全部入り: コア + 公式プラグイン15個 (ESM + IIFE)
```

必要なものだけを組み合わせる場合:

```bash
npm install @stargantt/core @stargantt/preset-standard
npm install @stargantt/plugin-tracking      # 公式プラグインは個別インストール可
npm install @stargantt/sdk                  # 自作プラグインの開発用
```

動作要件: デスクトップ/タブレット級のビューポート(横 720 × 縦 540 px 以上)。スマートフォン向けレイアウトは意図的に提供しません。

## パッケージ

| パッケージ | 内容 |
|---|---|
| `stargantt` | 単一ファイル配布: コア + 公式プラグイン15個、ESM + IIFE、CSS 埋め込み |
| `@stargantt/preset-standard` | 標準の 9 プラグイン構成(`presetStandard()`) |
| `@stargantt/core` | マイクロカーネル(minify 後 12 KB 未満、CI で機械的に強制) |
| `@stargantt/sdk` | プラグイン作者向けの型付きヘルパー |
| `@stargantt/plugin-*` | 公式プラグイン 15 個(個別インストール可) |

## 公式プラグイン

`presetStandard()` に含まれるもの:

| プラグイン | ID | 役割 |
|---|---|---|
| data-store | `stargantt.data-store` | タスク・リンク・リソース・割当・カスタムフィールド。すべての変更は取り消し可能なトランザクション |
| view | `stargantt.view` | レンダラー、ペインレイアウト、テーマ、タイムライン軸とヘッダ、グリッドと today ライン |
| tree-grid | `stargantt.tree-grid` | 左側グリッドペインと行モデル、標準カラム、セル編集、ルール駆動のバー着色 |
| task-bars | `stargantt.task-bars` | バーの描画。他プラグインが基準にするバー形状の所有者 |
| interaction | `stargantt.interaction` | 選択、ドラッグ編集、スナップ、ツールチップ、コンテキストメニュー、ズーム、クリップボード、フィルタ/検索、編集ダイアログ |
| undo-redo | `stargantt.undo-redo` | トランザクション履歴。undo は逆再生、redo は順再生 |
| a11y | `stargantt.a11y` | キーボード操作とスクリーンリーダー対応。拡張可能なショートカット表 |
| scheduling | `stargantt.scheduling` | 依存リンク、自動スケジューリングエンジン、稼働カレンダー、クリティカルパス、診断 |
| export | `stargantt.export` | 画像/PDF エクスポート、CSV/JSON/iCal/MS-Project 交換、.xlsx 書き出し、読み取り専用埋め込み表示 |

オプトイン(バンドルに同梱。ファクトリを `plugins` に追加して有効化):

| プラグイン | ID | 役割 |
|---|---|---|
| tracking | `stargantt.tracking` | ベースラインとスリップ、進捗トラッキング、コスト計算、EVM(出来高管理) |
| resource | `stargantt.resource` | リソース台帳、割当エディタ、リソース軸パネル、過負荷分析、負荷チャート |
| data-sync | `stargantt.data-sync` | REST/GraphQL スナップショット + 差分同期 + 楽観的書き戻し、オフラインスナップショット、リアルタイム転送 |
| portfolio | `stargantt.portfolio` | イニシアチブ–プログラム–プロジェクト階層と、ヘッドレスな KPI ダッシュボード |
| i18n | `stargantt.i18n` | フォールバックチェーン付きロケール辞書。全プラグインのメッセージカタログが共有 |
| perf-tools | `stargantt.perf-tools` | フレーム時間オーバーレイと描画性能診断用トレースレコーダー |

## アーキテクチャ

- **コアはガントチャートを知らない。** コアが提供するのはプラグインホスト、サービス、拡張ポイント、イベントバス、コマンドバスだけ。タスク・日付・描画はすべてプラグインの領分です。
- **裏口なし。** 公式プラグインは、サードパーティプラグインが使えるものと完全に同じ公開 API だけで作られています。組み込みプラグインにできることは、あなたのプラグインにもできます — 組み込みの丸ごと置き換えを含めて。
- **決定的な破棄。** プラグインが作るリソース(リスナー・DOM・タイマー)はすべて `ctx.own()` で登録し、破棄はコアが所有します。
- **実行時依存ゼロ。** `dependencies` にはワークスペース内部の `@stargantt/*`(ライブラリ自身の構成要素)以外、何も入りません。

完全な仕様は [`docs/specs/`](./docs/specs/) にあります — `architecture.md`、SDK 仕様、プラグインごとの仕様書。

## ドキュメント

- [ユーザードキュメント](https://wintermaples.github.io/star-gantt/) — ガイド、プラグインリファレンス、API リファレンス。掲載されているチャートはすべて実際に動く StarGantt インスタンスです。
- [Examples](https://wintermaples.github.io/star-gantt/examples/) — 47 枚の自己完結デモページ。各ページはリリースバンドルに対する HTML 1枚。

## コントリビュート

[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。要約: これは趣味プロジェクトでありサポート保証はありません。プラグインアーキテクチャは、メンテナーを待たずに必要なものを自分で作れるようにするためにあります。脆弱性報告は [SECURITY.md](./SECURITY.md) へ。

## ライセンス

[MIT](./LICENSE) © wintermaples
