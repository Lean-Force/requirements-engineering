# テスト戦略

このプロダクトの核は「コンテキスト(ドメイン知識・マップ)を AI へ正しく渡し、
AI の出力を安全にチームの共有物へ反映する」こと。テストはこの核が壊れたら
必ず落ちるように、次の原則とレイヤで構成する。

## 原則

1. **モックもフェイクも使わない。** LLM の後段にある本物の適用関数
   (`applySource` / `applyReextraction` / `recordConflicts` /
   `recordBoardProposal`)へリテラルの入力を渡して検証する。
   FS・ドメイン・ルート・プロンプト組み立て・永続化は常に本物を通す。
2. **LLM を跨ぐ経路は実 LLM のレイヤ(L4 eval / L5 システム)だけが検証する。**
   L0〜L3 は LLM を呼ばない(LLM 未設定の環境では取り込み時の
   矛盾・新業務スキャンは黙ってスキップされる)。
3. **1 つの不変条件は、それが壊れうる最下層でテストする。** 上の層は配線と
   体験だけを見る(同じ検証を層をまたいで重複させない)。
4. **決定的でない検証(実 LLM)は PASS/FAIL の判定を事実の包含に寄せる**
   (文言一致を避ける)。CI 常時ではなく、プロンプト・注入内容・モデルの
   変更時に必ず回す。

## レイヤ

| レイヤ | 対象 | LLM | 実行 | 場所 |
|---|---|---|---|---|
| L0 ドメイン | 純粋ロジック(正規化・確定保護・並び順) | 不要 | `npm run test:unit` | `tests/unit/domain.test.ts`, `schema.test.ts` |
| L1 ユースケース | 知識ベース・プロンプト注入内容・保存・ボード・ミューテックス(実 FS)。AI 成果物は適用関数へ直接入力 | 呼ばない | `npm run test:unit` | `tests/unit/{knowledge,presentation,map-skills,storage,boards,chat-lock}.test.ts` |
| L2 API 統合 | ルートハンドラ直呼びで LLM を跨がない配線(検証 → ユースケース → ドメイン → 保存 → レスポンス)+ LLM 経路のバリデーション | 呼ばない | `npm run test:unit` | `tests/integration/*.test.ts` |
| L3 E2E | ブラウザ + 実サーバー(UI 操作。知識パネルは適用関数でシード) | 呼ばない | サーバー起動後 `npm run test:e2e` | `features/*.feature` |
| L4 eval | 実 LLM の挙動(知識を必要なときに読む/読まない/正しく使う/守る/判定する)。ゲートウェイ関数を直接呼ぶ | **本物** | `npm run eval`(手動・変更時必須) | `tests/eval/run.mts` |
| L5 システム | **モック・フェイクなし**。ルートハンドラから実 LLM まで全配線を 1 シナリオで通す(取り込み → チャット → 確定保護 → 校正 → エントリ修正案 → 矛盾 → 新業務提案) | **本物** | `npm run test:system`(手動・リリース前) | `tests/system/run.mts` |
| 常時 | アーキテクチャ(層の依存ルール) | 不要 | `npm run test:unit` / `check:deps` | `architecture.test.ts` + `.dependency-cruiser.cjs` |

## 意味のあるパターン(不変条件)→ 担当レイヤ

**マップの安全性**
- 確定(fixed)要素は AI 出力が壊しても復元される — L0(enforceFixed)/ L5(chat ルート + 実 LLM)/ L4(モデルが拒み案内する)
- ストーリー表示順(storyOrder)は AI 出力に含まれず、サーバーが保持 — L0 / L2(正規化の往復)
- AI 出力は正規化されてから保存される — L0 / L2 / L5
- 同一ボードの AI ターンは到着順に直列 — L1(chat-lock)

**知識ベース**
- 知識・資料は全ボード共有(単一の共通スコープ) — L1(presentation / knowledge)
- off にした資料は skill から消え、再び on で戻る — L1 / L4(使われない)
- ✍️ 修正済み(edited)エントリは再抽出・同名更新で上書きされない — L1 / L2
- 同名ファイルは資料の更新(増殖しない・原資料差し替え) — L1 / L2
- 矛盾は記録・永続化され、解決/資料削除で消える — L1 / L2。検出品質と失敗耐性は L4 / L5
- 確定済みマップだけが全業務の常時注入に合成される — L1(map-skills)/ L4(参照して答える・齟齬を指摘する)

**提示(AI に何が渡るか)**
- チャット・校正の常時注入(buildChatContext: 業務一覧 + 全業務の合意済みマップ + 現在のマップ)に知識全文が入らない — L1(presentation / complex-system)
- ドメイン知識は kb-* skill へ描画される(SKILL.md 本文・出典・description のタイトル一覧と 1024 字上限・off 資料の除外・残骸掃除・鮮度) — L1(presentation / complex-system)
- 知識管理系(抽出・エントリ修正・業務判定)は知識全文を注入(buildBoardContext / buildKnowledgeContext) — L1(presentation)
- 「読むべき時に skill を読む / 機械的操作では読まない / 読んだ事実を正確に反映する / off の知識を使わない / 他業務の確定マップとの齟齬を指摘する」 — L4(usedSkills + 事実アサート)

**複雑システムのフィクスチャ(SORA銀行)**
- `tests/fixtures/complex-bank.ts` = 6 業務ボード + 共有知識 6 資料 38 エントリ(off 資料・旧規程の「見えてはいけない事実」含む)。L1(complex-system.test.ts)と L4(eval)が同じフィクスチャを使う
- `npm run seed:complex` で dev の data/ へ冪等にマージシード(cx- プレフィクスだけ入れ替え)。手動探索・デモにも使う

**会話の圧縮(古い経緯の要約)**
- いつ要約するか・要約と直近原文への分割・クリアや巻き戻しへの耐性 — L1(conversation)
- 要約が決定と理由を保持し、AI が要約経由で古い決定に答えられる — L4(会話の圧縮ケース)

**永続化・履歴**
- 版の畳み込み・上限・復元は履歴を増殖させない — L1(storage)
- 旧フォーマット(シングルボード・素の StoryMap・common なしエントリ)の互換 — L1(storage / boards / knowledge)

**API 契約**
- バリデーション(400)・存在チェック(404)・LLM 未設定(500) — L2
- レスポンス形(KnowledgeState / ChatResponse / versions) — L2

## 回し方

- 開発中・CI: `npm run test:unit`(L0〜L2 + アーキテクチャ。LLM 不要・決定的・十数秒)
- UI に触れたら: サーバーを `DATA_DIR=data/e2e-data` で起動して `npm run test:e2e`
- プロンプト / 注入内容の組み立て / 抽出 / モデルを変えたら: `npm run eval`(実 LLM・数分・$1 前後)
- リリース前・大きな配線変更のあと: `npm run test:system`(実 LLM で全配線・4 分前後・$2 前後)
