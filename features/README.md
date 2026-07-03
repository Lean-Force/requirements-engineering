# 受け入れテスト(Gherkin / BDD)

USM AI Chat の振る舞いを Gherkin で網羅的に記述したもの。用語は `MODEL.md` のユビキタス言語(アクター / アクティビティ / 行動 / ストーリー)に揃えている。

各 `.feature` は冒頭で `# language: ja` を宣言しており、Cucumber 等の日本語キーワード
(機能 / シナリオ / シナリオアウトライン / 前提 / もし / ならば / かつ / しかし / 例)で書かれている。

## 構成(レイヤーに対応)

| ファイル | 対象 | 層 |
|---|---|---|
| `actor.feature` | アクターの追加 | domain |
| `activity.feature` | アクティビティ(ナラティブフロー上の場面)と所属する行動 | domain |
| `action.feature` | 行動(Actor × Activity の交点)と配下ストーリーのカスケード | domain |
| `story.feature` | ストーリー(必ず行動にぶら下がる) | domain |
| `story-map.feature` | 集約ルート:イミュータビリティ・正規化・不変条件 | domain |
| `board.feature` | ボード表示と直接編集 | ui |
| `chat.feature` | チャットによるマップ生成(LiteLLM 経由) | app / infrastructure |
| `persistence.feature` | 永続化 API(GET/PUT)と旧データの正規化 | app / infrastructure |
| `e2e.feature` | ブラウザ操作でのボード編集(インライン編集・永続化) | E2E |
| `history.feature` | 会話の永続化・版履歴からの復元 | E2E |
| `canvas.feature` | キャンバスのパン・ズーム | E2E |

domain 系の `.feature` は仕様記述用に `@manual` タグを付けており、実行対象から除外している
(`cucumber.mjs` の `tags: "not @manual"`)。実際に動くのは `e2e.feature` / `history.feature` /
`canvas.feature` の 3 つ。

## 実行

E2E はブラウザ(Playwright)で実アプリを操作する。本番サンプル `data/storymap.json` を汚さないよう、
**専用データファイル + 別ポート**で dev サーバーを立て、そこへ向けて実行する。

```bash
# 1) 隔離サーバーを起動(保存先をテスト用ファイルに、ポートを分ける)
DATA_DIR=data/e2e-data PORT=3100 npm run dev

# 2) 別シェルでテスト実行(上記サーバーを指す)
E2E_BASE_URL=http://localhost:3100 npm run test:e2e
```

- 各シナリオは `Before` フックで `data/e2e-storymap.json` を初期化し、`AfterAll` で削除する。
- 会話・版履歴のテストは LLM を呼ばず、`world.seedSession()` で保存済み状態を直接用意して検証する。
- 各シナリオ終了時のスクリーンショットは `e2e-screenshots/` に保存される(目視・視覚回帰用)。
- ステップ定義は `features/steps/`、ブラウザ/World は `features/support/`。
