# ドメインモデル(USM)

このプロダクトが扱う User Story Map のドメインモデルを定義する。
UI やデータ構造はこのモデルに従う。

## 概念(エンティティ)

| 概念(ユーザー向け語彙) | コード上の名前 | 役割 | 例 |
|---|---|---|---|
| **アクター** | `Actor` | 登場人物 / 利用者種別。ボードでは「行」と「色」で区別する。 | 店員、お客様、管理者 |
| **アクティビティ** | `flowName` | 連続するステップをまとめる帯(意味のまとまり)。Patton 原典の Activities。 | 受付 / 審査・承認 / 実行・通知 |
| **ステップ** | `Activity` | ナラティブフロー上の1単位(時系列の1コマ = 列)。**順序を持つ**(並び順=左→右=時系列)。1つのステップに複数アクターが参加しうる。 | 「商品の受け渡し」 |
| **タスク** | `Action` | **あるアクターが・あるステップで**行う行動の付箋。`Actor × ステップ` の交点。 | 店員が「商品を受け取る」/ お客様が「商品を渡す」 |
| **ストーリー** | `Story` | あるタスクを実現するユーザーストーリー。「◯◯は〜したい。なぜなら〜だからだ。」(目的・理由まで書く)。複数あれば時系列に並べる。 | 「店員は、クーポンを知らせたい。なぜなら、お得に買い物してもらい再来店につなげたいからだ。」 |
| **バックボーン** | — | ステップとタスクが作る骨格全体(activity line)。 | — |

> **注(語彙の決定・2026-07-10 確定)**: ユーザー向け語彙は
> **バックボーン > アクティビティ(帯)> ステップ(列)> タスク > ストーリー**。
> 「場面」「行動」「流れ(帯の意味)」という語は廃止。
> コードの `Activity` 型は歴史的経緯で「ステップ」を指す(Patton 原典の
> Activities に相当するのは `flowName`)。JSON スキーマ・保存データの互換のため
> 型名は変えない。この対応表が正。製品固有の点は「1つのステップ(列)に
> 複数アクターのタスクが縦に並ぶ」こと(原典は1列=1タスク)。

## 関係(カーディナリティ)

```
StoryMap ──< Actor
StoryMap ──< Activity            (順序あり = ナラティブフロー)
Activity ──< Action              (1 Activity に各アクター最大1つ)
Action   = Actor(1) × Activity(1)   (どのアクターの・どのステップのタスクか)
Action ──< Story                 (時系列に並ぶ)
```

## 不変条件(invariant)

- **Story は必ず Action にぶら下がる。** したがって Story は常に「1人の Actor」と「1つの Activity」に(Action を介して)紐づく。宙に浮いた Story は作れない。
- Action は必ず 1つの Actor と 1つの Activity に属する。
- Activity は順序を持ち、その並びがナラティブフロー(時系列)を表す。
- ある Activity で行動しない Actor は、その列が空欄になる(列の整列は保たれる)。

「Story / Actor / ステップ」の3軸があり、それらを結ぶ交点(セル)が **Action(タスク)** である。

## ボード表示との対応(2レイヤー)

ボードは上下2つの「ライン」で構成される。両者は同じ列(Activity)・同じ幅で縦に揃う。

- **activity line(バックボーン)**:行 = Actor(色分け)、列 = Activity(共有タイムライン)。
  セル(Actor × Activity)= Action の付箋(タスク)。Activity は途中挿入も可(`addActivity(map, index)`)。
- **ナラティブフロー矢印**(時系列)が両ラインの境界。
- **story line**:activity line 全体の下に置く帯。各 Activity 列の下に、その列の各 Action の Story を
  **アクター色で**まとめて並べる(同一 Action の複数 Story は時系列に横並び)。
  Story は引き続き Action に紐づく(`data-action-id` で activity line のタスクと対応)。

## レイヤー構成(UI とドメインモデルの分離)

依存は常に外側 → 内側(`ui` / `infrastructure` / `app` → `domain`)。ドメイン層は React・fs・外部API に依存しない。

| 層 | ディレクトリ | 責務 | 依存してよい先 |
|---|---|---|---|
| **Domain(ドメイン)** | `domain/` | エンティティ単位のモジュール(`actor` / `story` / `action` / `activity`)と集約ルート(`story-map`)。純粋。 | なし |
| **Infrastructure(インフラ)** | `infrastructure/` | 永続化(`storage.ts`)・外部API(`claude.ts`) | domain |
| **Contracts(契約)** | `contracts.ts` | UI ↔ API の転送DTO(`ChatMessage` / `ChatResponse`) | domain |
| **UI(表現)** | `ui/` | React コンポーネント(`Board` / `ChatPanel`)。色・幅・文字サイズ等の表示専用ロジックのみ。 | domain / contracts |
| **App(配線)** | `app/` | ルーティング・API ハンドラ。各層を組み合わせる。 | すべて |

ルール:
- **ドメインの変更は必ず `domain/story-map.ts` の操作を経由する。** UI は `structuredClone` などで構造を直接いじらない。
- **表示専用の値(色・列幅・フォントサイズ)は UI 層にのみ置く。** ドメインは見た目を知らない。
- 不変条件(下記)はドメイン層で守られ、UI には漏れない。

## モデル ↔ コードのマッピング(エンティティ単位)

エンティティごとに1ファイル。各ファイルが自分の型・ファクトリ・局所的なふるまいを持つ。

| モデル | 定義ファイル | 型 / フィールド | 主な API |
|---|---|---|---|
| Actor | `domain/actor.ts` | `Actor { id, name }` | `createActor` |
| Story | `domain/story.ts` | `Story { id, text }` | `createStory` / `withText` |
| Action | `domain/action.ts` | `Action { id, actorId, text, stories }` | `createAction` / `withNewStory` / `withRenamedStory` / `withoutStory` |
| Activity | `domain/activity.ts` | `Activity { id, actions }` | `createActivity` / `actionOf` / `withNewAction` / `mapAction` / `withoutAction` |
| StoryMap(集約ルート) | `domain/story-map.ts` | `StoryMap { actors, activities }` | 下記の集約操作 |

- 各エンティティの **`with〜`(局所ふるまい)は集約の実装詳細**で、`domain/index.ts` では公開しない。
- 外部(UI / app)が使うのは集約ルートの操作だけ:`addActor` / `addActivity` / `addAction` / `renameAction` / `removeAction` / `addStory` / `renameStory` / `removeStory`(+ 問い合わせ `actionOf` / `findActivity` / `findAction`、初期化 `emptyStoryMap` / `normalizeStoryMap`)。これが集約への**唯一の変更入口**。
- 不変条件の宿る場所:「各アクター最大1の Action」→ `activity.withNewAction`、「Story は Action 配下のみ」→ `story-map.addStory` が Action までナビゲートして初めて追加する構造。

## 将来の拡張(モデル上の位置づけ)

- **Activity の上位グルーピング**: 複数の Activity をまとめる大区分(USM 背骨の上段)。必要になれば導入。
- **Release(リリース)**: Story を縦方向のスライスに割り当てる(Release 1 = MVP …)。USM の次ステップ。Story に `releaseId` を持たせて表現する想定。
