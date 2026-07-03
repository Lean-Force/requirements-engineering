# テスト戦略

このプロダクトの核は「コンテキスト(ドメイン知識・マップ)を AI へ正しく渡し、
AI の出力を安全にチームの共有物へ反映する」こと。テストはこの核が壊れたら
必ず落ちるように、次の原則とレイヤで構成する。

## 原則

1. **モックしてよい境界は LLM だけ。** それも `vi.mock` ではなく、プロダクトが
   公式に持つテストモード **`USM_FAKE_LLM=1`**(`infrastructure/agent/fake.ts` の
   決定的フェイク)で差し替える。FS・ドメイン・ルート・skill 描画・永続化は
   常に本物を通す。
2. **フェイクにした LLM の本物挙動は eval(L4)が同じ関数契約で検証する。**
   フェイクと実装は `generate` / `extractKnowledgeMulti` / `refineCard` /
   `reviseEntry` / `detectConflicts` という同一シグネチャを共有しており、
   下のレイヤで代替した分は必ず L4 が埋める(境界の上下で契約が一致)。
3. **1 つの不変条件は、それが壊れうる最下層でテストする。** 上の層は配線と
   体験だけを見る(同じ検証を層をまたいで重複させない)。
4. **決定的でない検証(実 LLM)は PASS/FAIL の判定を事実の包含に寄せる**
   (文言一致を避ける)。CI 常時ではなく、プロンプト・skill 描画・モデルの
   変更時に必ず回す。

## レイヤ

| レイヤ | 対象 | LLM | 実行 | 場所 |
|---|---|---|---|---|
| L0 ドメイン | 純粋ロジック(正規化・確定保護・並び順) | 不要 | `npm run test:unit` | `tests/unit/domain.test.ts`, `schema.test.ts` |
| L1 ユースケース | 知識ベース・skill 描画・保存・ボード・ミューテックス(実 FS) | フェイク | `npm run test:unit` | `tests/unit/{knowledge,presentation,map-skills,storage,boards,chat-lock}.test.ts` |
| L2 API 統合 | ルートハンドラ直呼びで **全配線**(検証 → ユースケース → ドメイン → 保存 → skill 描画 → レスポンス) | フェイク | `npm run test:unit` | `tests/integration/*.test.ts` |
| L3 E2E | ブラウザ + 実サーバー(マルチユーザー同期・UI 操作) | 使わない操作が中心 | サーバー起動後 `npm run test:e2e` | `features/*.feature` |
| L4 eval | 実 LLM の挙動(読むべき時に読む/使う/守る) | **本物** | `npm run eval`(手動・変更時必須) | `tests/eval/run.mts` |
| 常時 | アーキテクチャ(層の依存ルール) | 不要 | `npm run test:unit` / `check:deps` | `architecture.test.ts` + `.dependency-cruiser.cjs` |

## 意味のあるパターン(不変条件)→ 担当レイヤ

**マップの安全性**
- 確定(fixed)要素は AI 出力が壊しても復元される — L0(enforceFixed)/ L2(chat ルート経由)/ L4(モデルが拒み案内する)
- ストーリー表示順(storyOrder)は AI 出力に含まれず、サーバーが保持 — L0 / L2
- AI 出力は正規化されてから保存される — L0 / L2
- 同一ボードの AI ターンは到着順に直列 — L1(chat-lock)/ L2(並行 POST)

**知識ベース**
- 業務 A の知識は業務 B に一切現れない(分離) — L1(presentation)
- off にした資料は skill から消え、再び on で戻る — L1 / L4(使われない)
- common 判定でエントリが kb-* / kb-common-* に振り分く — L1 / L2 / L4(判定品質)
- ✍️ 修正済み(edited)エントリは再抽出・同名更新で上書きされない — L1 / L2
- 同名ファイルは資料の更新(増殖しない・原資料差し替え) — L1 / L2
- 矛盾は検出・永続化され、解決/資料削除で消える。検出失敗は取り込みを止めない — L1 / L2 / L4(検出品質)
- 確定済みマップだけが kb-common-maps に合成され全業務から見える — L1(map-skills)/ L4(参照して答える)

**提示(AI に何が渡るか)**
- skill 名の集合と SKILL.md の中身(description のトリガー・原文どおりの事実) — L1(presentation)
- 渡した skill が実際にロードされたか — 運用ログ(skills-mismatch)+ L4 の usedSkills
- 読むべき時に読む / 読まなくていい時に読まない — L4

**永続化・履歴**
- 版の畳み込み・上限・復元は履歴を増殖させない — L1(storage)
- 旧フォーマット(シングルボード・素の StoryMap・common なしエントリ)の互換 — L1(storage / boards / knowledge)

**API 契約**
- バリデーション(400)・存在チェック(404)・LLM 未設定(500) — L2
- レスポンス形(KnowledgeState / ChatResponse / versions) — L2

## フェイク LLM のディレクティブ

テストは入力(メッセージ・ファイル内容・指示)にディレクティブを埋め込んで
AI の出力を決定的に制御する。書式は `infrastructure/agent/fake.ts` の冒頭を参照
(`FAKEMAP:` / `KB|…` / `NOKB` / `CONFLICTS_JSON:` / `FAKESUGGEST:` / `REVISE|…`)。

## 回し方

- 開発中・CI: `npm run test:unit`(L0〜L2 + アーキテクチャ。LLM 不要・決定的・十数秒)
- UI に触れたら: サーバーを `DATA_DIR=data/e2e-data` で起動して `npm run test:e2e`
- プロンプト / skill 描画 / 抽出 / モデルを変えたら: `npm run eval`(実 LLM・数分・$1 前後)
