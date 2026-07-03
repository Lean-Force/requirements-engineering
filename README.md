# USM AI Chat

AI Agent Chatを通じてUser Story Mappingを整理・可視化するプロダクト。

## 概要

チャットベースのインターフェースでAIと対話しながら、User Story Mapを構築・整理できるツール。
AIがユーザーの入力からアクティビティ、ユーザータスク、ユーザーストーリーを抽出・提案し、カンバン風のボードUIにリアルタイムで反映する。

## 主な機能

- **AIチャットによるストーリー整理**: 自然言語でプロダクトの要件を伝えると、AIがUser Story Mapの要素に分解・構造化
- **コンテキスト(参照資料)**: 要件一覧・業務フロー・議事録・用語集などの Excel / CSV / PDF / テキストをアップロードすると Agent Skill として保存され、AI が必要と判断したときだけ参照する(progressive disclosure)。資料単位で on/off 可能
- **カンバン風ボードUI**: アクティビティ → ユーザータスク → ユーザーストーリーの階層をビジュアルに表示
- **ドラッグ&ドロップ編集**: ストーリーの並び替え、優先度の変更、リリース単位のグルーピング
- **チーム共有**: 全員で 1 枚のマップを共有。他メンバーの変更・AI ターンは SSE でリアルタイムに反映され、AI ターンは到着順に直列処理される

## 技術スタック

- **フロントエンド**: Next.js / React
- **AI**: Claude Agent SDK 経由で Claude を呼び出し(本番は Amazon Bedrock、AWS 認証は標準チェーン = EKS では IRSA)
- **UI**: カンバン風ボードコンポーネント

## User Story Mapの構造

```
アクティビティ(Activity)
├── ユーザータスク(User Task)
│   ├── ユーザーストーリー(User Story) ← Release 1
│   ├── ユーザーストーリー(User Story) ← Release 2
│   └── ユーザーストーリー(User Story) ← Release 3
└── ユーザータスク(User Task)
    ├── ユーザーストーリー(User Story) ← Release 1
    └── ユーザーストーリー(User Story) ← Release 2
```

## 開発

```bash
# セットアップ
npm install

# LLM の接続情報を設定
cp .env.example .env.local
# Bedrock 経由: CLAUDE_CODE_USE_BEDROCK=1 + AWS_REGION + ANTHROPIC_MODEL(us.anthropic.… 形式)
#   AWS 認証は標準クレデンシャルチェーン(ローカルはプロファイル、EKS は IRSA)
# ローカル開発の代替: ANTHROPIC_API_KEY で Anthropic API 直結

# 開発サーバー起動
npm run dev
# → http://localhost:3000
```

LLM の接続情報は **サーバー側の API Route(`/api/chat`)でのみ** 使用し、ブラウザには公開されません。
未設定でもボード表示・編集は動作します(チャット送信時のみ必要)。

## アーキテクチャ(レイヤー分離・詳細は MODEL.md)

```
domain/          ドメイン層(純粋。エンティティ単位 + 集約ルート StoryMap)
infrastructure/  外界(storage = ファイル永続化 / agent = LLM ゲートウェイ /
                 context = 参照資料の Skill 化 / events = SSE 用イベントバス)
contracts.ts     層をまたぐ転送DTO(ChatMessage / ChatResponse / ContextDocMeta / BoardEvent)
ui/              表現層(Board / ChatPanel / ContextPanel。React のみ)
app/             配線(ページ / API ルート)
```

- **チャット → マップ生成**: `/api/chat` が会話履歴と現在のマップを `infrastructure/agent`(Claude Agent SDK + `json_schema` 構造化出力)に渡し、「返信」+「更新後のマップ全体」を受け取る。AI ターンはグローバルミューテックスで直列化。
- **コンテキスト**: `/api/contexts` にアップロードされたファイルは 1 ファイル = 1 skill として Markdown 化され(Excel の複数シートはセクションとして保持)、`data/workspace/.claude/skills/<id>/SKILL.md` として保存。AI は description を常時見て、必要なときだけ本文を Read する。ワークスペース外への Read は PreToolUse フックで遮断。
- **チーム同期**: 変更は `/api/events`(SSE)で全クライアントへ通知(薄い通知 → 再取得)。単一レプリカ前提。
- **永続化**: マップは `data/storymap.json` にファイル保存(`/api/storymap` の GET/PUT)。
- **ボード直接編集**: 行動・ストーリーの追加 / 編集 / 削除。変更は必ず `domain` の集約操作を経由し、即 `data/storymap.json` へ保存。

使用モデルは `ANTHROPIC_MODEL`(Bedrock はインファレンスプロファイル形式 `us.anthropic.…` でピニング)で設定する。
