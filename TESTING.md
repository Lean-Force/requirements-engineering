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
| L3 E2E | ブラウザ + 実サーバー(マルチユーザー同期・UI 操作) | 使わない操作が中心 | サーバー起動後 `npm run test:e2e` | `features/*.feature` |
| L4 eval | 実 LLM の挙動(知識を正しく使う/守る/判定する)。ゲートウェイ関数を直接呼ぶ | **本物** | `npm run eval`(手動・変更時必須) | `tests/eval/run.mts` |
| L5 システム | **モック・フェイクなし**。ルートハンドラから実 LLM まで全配線を 1 シナリオで通す(取り込み → チャット → 確定保護 → 校正 → 矛盾 → 新業務提案) | **本物** | `npm run test:system`(手動・リリース前) | `tests/system/run.mts` |
| 常時 | アーキテクチャ(層の依存ルール) | 不要 | `npm run test:unit` / `check:deps` | `architecture.test.ts` + `.dependency-cruiser.cjs` |

## 意味のあるパターン(不変条件)→ 担当レイヤ

**マップの安全性**
- 確定(fixed)要素は AI 出力が壊しても復元される — L0(enforceFixed)/ L5(chat ルート + 実 LLM)/ L4(モデルが拒み案内する)
- ストーリー表示順(storyOrder)は AI 出力に含まれず、サーバーが保持 — L0 / L2(正規化の往復)
- AI 出力は正規化されてから保存される — L0 / L2 / L5
- 同一ボードの AI ターンは到着順に直列 — L1(chat-lock)

**知識ベース**
- 業務 A の知識は業務 B に一切現れない(分離) — L1(presentation)
- off にした資料は注入内容から消え、再び on で戻る — L1 / L4(使われない)
- スコープ方針(用語・アクター常に共通、他は AI 判定)どおりに振り分く — L1 / L2 / L4(判定品質)
- ✍️ 修正済み(edited)エントリは再抽出・同名更新で上書きされない — L1 / L2
- 同名ファイルは資料の更新(増殖しない・原資料差し替え) — L1 / L2
- 矛盾は記録・永続化され、解決/資料削除で消える — L1 / L2。検出品質と失敗耐性は L4 / L5
- 確定済みマップだけが全業務の注入内容に合成される — L1(map-skills)/ L4(参照して答える)

**提示(AI に何が渡るか)**
- system prompt へ注入される全文(buildKnowledgeContext: 業務の分離・on/off・原文どおりの事実・共通の合成・確定マップ) — L1(presentation / map-skills)
- 注入された知識が答えに正しく効くか / 頼んでいない知識が混入しないか — L4
(知識は常に全文注入されるため「読む/読まない」の概念はない。Agent Skills は撤去済み)

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
