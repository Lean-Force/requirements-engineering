# USM AI Chat

AI Agent Chatを通じてUser Story Mappingを整理・可視化するプロダクト。

## 概要

チャットベースのインターフェースでAIと対話しながら、User Story Mapを構築・整理できるツール。
AIがユーザーの入力からアクティビティ、ユーザータスク、ユーザーストーリーを抽出・提案し、カンバン風のボードUIにリアルタイムで反映する。

## 主な機能

- **AIチャットによるストーリー整理**: 自然言語でプロダクトの要件を伝えると、AIがUser Story Mapの要素に分解・構造化
- **ドメイン知識ベース**: 要件一覧・業務フロー・議事録・用語集などの Excel / CSV / PDF / テキストをアップロードすると、AI が固定5カテゴリ(用語集 / アクター / 業務フロー・ルール / データ・IF定義 / 背景・課題)のドメイン知識に抽出・蓄積する。知識はカテゴリごとの Agent Skill になり、AI が必要と判断したときだけ参照(progressive disclosure)。各知識は出典(元ファイル)を保持し、資料単位で on/off 可能
- **カンバン風ボードUI**: アクティビティ → ユーザータスク → ユーザーストーリーの階層をビジュアルに表示
- **ドラッグ&ドロップ編集**: ストーリーの並び替え、優先度の変更、リリース単位のグルーピング
- **ボード = 業務**: 業務ごとにボードを作り、マップ・会話・ドメイン知識をボード単位で管理。業務横断の知識(全社用語集など)は「共通知識」として全ボードで参照される
- **チーム共有**: 同じボードを開いたメンバーでマップを共有。他メンバーの変更・AI ターンは SSE でリアルタイムに反映され、AI ターンはボードごとに到着順で直列処理される

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
- **ボード = 業務**: `data/workspaces/<boardId>/` にマップ・会話・版履歴・知識ベースを集約(`data/boards.json` が一覧)。旧シングルボード形式は初回アクセス時に「最初のボード」へ自動移行される。
- **ドメイン知識ベース**: `/api/boards/<id>/contexts` にアップロードされたファイルは「ソース(原資料)」として保存され、LLM が固定カテゴリの知識エントリへ抽出(`infrastructure/agent.extractKnowledge`)。エントリは出典付きで蓄積され、カテゴリごとに `kb-<category>` skill へレンダリングされる(description にエントリのタイトル一覧が入る)。業務横断の共通知識は `workspaces/_common/` に置かれ、チャット直前に各ボードへ `kb-common-<category>` として同期される。AI は description を常時見て、必要なときだけ本文を Read する。ワークスペース外への Read は PreToolUse フックで遮断。
- **チーム同期**: 変更は `/api/boards/<id>/events`(SSE)でそのボードのクライアントへ通知(薄い通知 → 再取得)。単一レプリカ前提。
- **永続化**: マップはボードのワークスペース内 `session.json` にファイル保存(`/api/boards/<id>/storymap` の GET/PUT)。
- **ボード直接編集**: 行動・ストーリーの追加 / 編集 / 削除。変更は必ず `domain` の集約操作を経由し、即 `data/storymap.json` へ保存。

使用モデルは `ANTHROPIC_MODEL`(Bedrock はインファレンスプロファイル形式 `us.anthropic.…` でピニング)で設定する。
