# USM AI Chat

AI Agent Chatを通じてUser Story Mappingを整理・可視化するプロダクト。

## 概要

チャットベースのインターフェースでAIと対話しながら、User Story Mapを構築・整理できるツール。
AIがユーザーの入力からアクティビティ、ユーザータスク、ユーザーストーリーを抽出・提案し、カンバン風のボードUIにリアルタイムで反映する。

## 主な機能

- **AIチャットによるストーリー整理**: 自然言語でプロダクトの要件を伝えると、AIがUser Story Mapの要素に分解・構造化
- **カンバン風ボードUI**: アクティビティ → ユーザータスク → ユーザーストーリーの階層をビジュアルに表示
- **ドラッグ&ドロップ編集**: ストーリーの並び替え、優先度の変更、リリース単位のグルーピング
- **リアルタイム同期**: チャットでの変更がボードに即座に反映

## 技術スタック

- **フロントエンド**: Next.js / React
- **AI**: LiteLLM(OpenAI 互換)経由で LLM を呼び出し(モデルは差し替え可能)
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

# LiteLLM の接続情報を設定
cp .env.example .env.local
# .env.local を開き LITELLM_BASE_URL / LITELLM_API_KEY(必要なら LITELLM_MODEL)を設定
# ※ 別途 LiteLLM プロキシを起動しておく(https://docs.litellm.ai/docs/proxy/quick_start)

# 開発サーバー起動
npm run dev
# → http://localhost:3000
```

LiteLLM の接続情報は **サーバー側の API Route(`/api/chat`)でのみ** 使用し、ブラウザには公開されません。
未設定でもボード表示・編集は動作します(チャット送信時のみ必要)。

## アーキテクチャ(レイヤー分離・詳細は MODEL.md)

```
domain/          ドメイン層(純粋。エンティティ単位 + 集約ルート StoryMap)
infrastructure/  外界(storage = ファイル永続化 / litellm = LLM ゲートウェイ)
contracts.ts     層をまたぐ転送DTO(ChatMessage / ChatResponse)
ui/              表現層(Board / ChatPanel。React のみ)
app/             配線(ページ / API ルート)
```

- **チャット → マップ生成**: `/api/chat` が会話履歴と現在のマップを `infrastructure/litellm`(LiteLLM 経由・OpenAI 互換 chat completions + `json_schema` 構造化出力)に渡し、「返信」+「更新後のマップ全体」を JSON で受け取る。
- **永続化**: マップは `data/storymap.json` にファイル保存(`/api/storymap` の GET/PUT)。
- **ボード直接編集**: 行動・ストーリーの追加 / 編集 / 削除。変更は必ず `domain` の集約操作を経由し、即 `data/storymap.json` へ保存。

使用モデルは `LITELLM_MODEL`(省略時 `claude-opus-4-8`)、接続先は `LITELLM_BASE_URL` / `LITELLM_API_KEY` で設定する。
