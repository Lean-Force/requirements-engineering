# USM AI Chat

AI Agent Chat を通じて User Story Mapping を整理・可視化するプロダクト。

## 概要

チャットベースのインターフェースで AI と対話しながら、User Story Map を構築・整理できるツール。
AI がユーザーの入力からアクティビティ・ステップ・タスク・ストーリーを抽出・提案し、カンバン風のボード UI にリアルタイムで反映する。

## 主な機能

- **AI チャットによるマップ編集**: 自然言語でプロダクトの要件を伝えると、AI が User Story Map の要素（アクティビティ / ステップ / タスク / ストーリー）に分解・構造化。ステップの追加・削除・並び替えもチャットから指示できる
- **ドメイン知識ベース**: Excel / CSV / PDF / テキストをアップロードすると、AI が固定 5 カテゴリ（用語集 / アクター / 業務フロー・ルール / データ・IF 定義 / 背景・課題）のドメイン知識に抽出・蓄積。全ボード共有で、AI が必要と判断したときだけ参照する（Agent Skills）
- **カンバン風ボード UI**: アクティビティ（帯）→ ステップ → タスク → ストーリーの階層をビジュアルに表示
- **ドラッグ&ドロップ編集**: ストーリーの並び替え、優先度の変更、リリースライン間の移動
- **リリースライン**: ストーリーを MVP / フェーズ 2 … にグルーピングする横断線
- **論点(議論ポイント)**: ストーリー・タスク・ステップ・ボード全体に「議論すべきこと」をメモ。解決時は結論と理由を必須で残すため、そのまま合意の記録（rationale）になる。未解決の論点は AI にも渡り、決め打ちを防ぐ
- **PBI 化（EARS 記法）**: ストーリーをワンクリックで PBI に変換。受入基準は EARS 記法（通常 / イベント駆動 / 状態駆動 / 望ましくない挙動 / オプション）で生成され、ドメイン知識の数値・閾値が正確に反映される。未解決の論点は要求化せず「未決事項」として明示。Markdown コピーでバックログツールへ
- **チーム共有**: 同じボードを開いたメンバーでマップを共有。他メンバーの変更・AI ターンは SSE でリアルタイムに反映

## Docker で起動

```bash
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v usm-data:/app/data \
  ghcr.io/lean-force/requirements-engineering:latest
```

http://localhost:3000 でアクセスできる。

### LLM 接続の設定

3 つの接続方法がある。いずれか 1 つを環境変数で指定する。

| 方法 | 環境変数 | 用途 |
|---|---|---|
| Anthropic API 直結 | `ANTHROPIC_API_KEY=sk-ant-...` | 最もシンプル |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` + AWS 認証情報 | 本番 / EKS（IRSA） |
| ローカル Claude Code | `CLAUDE_LOCAL_AUTH=1` | このマシンの `~/.claude` 認証を使う |

**ローカル Claude Code 認証を Docker で使う場合:**

```bash
docker run -p 3000:3000 \
  -e CLAUDE_LOCAL_AUTH=1 \
  -e ANTHROPIC_MODEL=claude-opus-4-8 \
  -v usm-data:/app/data \
  -v ~/.claude:/home/nextjs/.claude:ro \
  ghcr.io/lean-force/requirements-engineering:latest
```

### その他の環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `ANTHROPIC_MODEL` | (SDK 既定) | モデル ID。Bedrock は `us.anthropic.claude-opus-4-8` 形式 |
| `DATA_DIR` | `/app/data` | 永続データの保存先 |
| `CHAT_MAX_TURNS` | `24` | エージェントループの上限ターン数 |
| `CHAT_VERBATIM_MESSAGES` | `20` | 原文のまま AI へ渡す直近の会話数（それより古い経緯は要約に圧縮） |
| `CHAT_COMPACT_BATCH` | `10` | 未要約の古い発話がこの件数溜まったら要約を更新 |
| `CONTEXT_WINDOW_TOKENS` | `200000` | コンテキストウィンドウ上限（トークン数） |
| `PORT` | `3000` | サーバーポート |

### データの永続化

ボード・マップ・会話履歴・ドメイン知識はすべて `DATA_DIR`（既定: `/app/data`）に保存される。Docker ではボリュームマウントで永続化する:

```bash
-v usm-data:/app/data        # 名前付きボリューム
-v ./my-data:/app/data        # ホストディレクトリ
```

## ローカル開発

```bash
npm install

# .env.local を設定
cp .env.example .env.local
# ANTHROPIC_API_KEY / CLAUDE_CODE_USE_BEDROCK / CLAUDE_LOCAL_AUTH のいずれかを設定

npm run dev
# → http://localhost:3000
```

LLM の接続情報はサーバー側の API Route でのみ使用し、ブラウザには公開されない。
未設定でもボード表示・編集は動作する（チャット送信時のみ必要）。

## User Story Map の構造

語彙: バックボーン / アクティビティ / ステップ / タスク / ストーリー。
(コードの `Activity` 型は歴史的経緯でステップを指す。対応表は MODEL.md)

```
アクティビティ(flowName) ─ 連続するステップをまとめる帯
└── ステップ(Activity) ─ 時系列の 1 コマ。並びがバックボーン
    ├── タスク(Action) ─ アクター × ステップ の付箋
    │   ├── ストーリー(Story) ← Release 1
    │   └── ストーリー(Story) ← Release 2
    └── タスク(Action)
        └── ストーリー(Story) ← Release 1
```

## アーキテクチャ

```
domain/          ドメイン層（純粋・依存ゼロ）
infrastructure/  外界（LLM ゲートウェイ / 知識ベース / 永続化）
ui/              表現層（Board / ChatPanel / ContextPanel）
app/             配線（ページ / API ルート）
contracts.ts     層をまたぐ転送 DTO
```

詳細は MODEL.md を参照。層の依存ルールは `.dependency-cruiser.cjs` で強制。

## テスト

```bash
npm run test:unit     # vitest（domain・知識ベース・スキーマ同期・アーキテクチャ）
npm run check:deps    # 依存関係ルール
npm run eval          # LLM eval（要 LLM 接続。プロンプト変更時に手動実行）
```
