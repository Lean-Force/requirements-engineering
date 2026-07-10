// 層をまたぐ転送 DTO(ドメインそのものではなく、UI ↔ API のやり取りの形)。
import type { StoryMap } from "@/domain";

/** チャットの 1 メッセージ */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** マップの 1 スナップショット(版)。保存実体には storyMap 全体を含む。 */
export interface StoryMapVersion {
  id: string;
  /** 作成時刻(ISO 文字列) */
  createdAt: string;
  /** 版が生まれたきっかけ */
  source: "chat" | "edit" | "restore";
  /** 一覧表示用の要約(AI 返信やアクション説明) */
  summary: string;
  storyMap: StoryMap;
}

/** 版の一覧表示用(重い storyMap を除いたメタ情報) */
export type StoryMapVersionMeta = Omit<StoryMapVersion, "storyMap">;

/** 永続化される 1 セッション分の状態(マップ + 会話 + 版履歴) */
export interface BoardSession {
  storyMap: StoryMap;
  messages: ChatMessage[];
  versions: StoryMapVersion[];
}

/** GET /api/session のレスポンス(初期ロード用。版は一覧メタのみ) */
export interface SessionState {
  storyMap: StoryMap;
  messages: ChatMessage[];
  versions: StoryMapVersionMeta[];
}

/** /api/chat のレスポンス形(返信 + 更新後のドメイン集約 + 最新の版一覧) */
export interface ChatResponse {
  reply: string;
  storyMap: StoryMap;
  versions?: StoryMapVersionMeta[];
}

/** 付箋(タスク / ストーリー)の AI 校正リクエスト(/api/boards/[id]/refine) */
export interface RefineRequest {
  kind: "action" | "story";
  /** 現在の本文 */
  text: string;
  /** 付箋のアクター名(ストーリーの主語・タスクの主体) */
  actorName?: string;
  /** 同じステップにあるタスクの本文一覧(文脈用) */
  sceneActions?: string[];
  /** ストーリーがぶら下がるタスクの本文(kind = story のとき) */
  actionText?: string;
}

/** AI 校正のレスポンス */
export interface RefineResponse {
  /** 付箋にそのまま入れられる推敲後の本文 */
  suggestion: string;
  /** 何を直したか・その根拠(1〜2文) */
  note: string;
}

/**
 * ドメイン知識のカテゴリ(固定タクソノミー)。
 * カテゴリごとに 1 つの Agent Skill(kb-*)としてレンダリングされ、
 * AI は description(エントリのタイトル一覧)を見て必要なときだけ読む。
 */
export type KnowledgeCategory =
  | "terms" // 用語集
  | "actors" // アクター(登場人物・役割・システム)
  | "flows" // 業務フロー・ルール
  | "data" // データ・IF定義
  | "background"; // 背景・課題

/** 取り込まれた原資料(ソース)のメタ情報。アップロードした場所(ボード or 共通管理画面)に属する */
export interface SourceMeta {
  id: string;
  fileName: string;
  /** このソース由来の知識を AI に提示するか(チーム共有の状態) */
  enabled: boolean;
  /** 抽出されたエントリ数 */
  entryCount: number;
  uploadedAt: string;
}

/** ソースから抽出されたドメイン知識の 1 エントリ */
export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  /** 短い見出し(検索・トリガーの手がかり) */
  title: string;
  /** 本文(Markdown)。値域・条件などは原文どおり */
  content: string;
  /** 出典ソース */
  sourceId: string;
  /** true = 業務横断の共通知識(AI が抽出時に自動判定し、全ボードから参照される) */
  common: boolean;
  /** true = 人が(AI と協働で)直したエントリ。再抽出しても上書きされない */
  edited?: boolean;
}

/** エントリ編集の保存内容(PATCH /…/entries/[entryId]) */
export interface EntryPatch {
  title: string;
  content: string;
  common: boolean;
}

/** AI によるエントリ修正案(POST /…/entries/[entryId]/revise) */
export interface EntryRevision extends EntryPatch {
  /** 何をどう直したか・原文との食い違いがあればその指摘(1〜2文) */
  note: string;
}

/** カテゴリの一覧表示用サマリ */
export interface KnowledgeCategorySummary {
  category: KnowledgeCategory;
  label: string;
  /** 有効なソース由来のエントリ数 */
  count: number;
}

/** 取り込み時に検出された、新旧の知識の食い違い(人が解消するまで残る) */
export interface KnowledgeConflict {
  id: string;
  detectedAt: string;
  /** 何についての食い違いか(例: 送金の承認閾値) */
  topic: string;
  /** 新しく取り込んだ資料名とその主張 */
  newSource: string;
  newClaim: string;
  /** 既存側(資料名 / 確定済みマップ)とその主張 */
  existingSource: string;
  existingClaim: string;
  /** 掃除用(資料削除時に関連する矛盾を消す) */
  newSourceId: string;
  existingSourceId?: string;
}

/** 取り込み時に AI が検知した「新しい業務」のボード作成提案 */
export interface BoardProposal {
  id: string;
  detectedAt: string;
  /** 提案のもとになった資料 */
  sourceId: string;
  fileName: string;
  /** AI が命名した業務名(ボード名の候補) */
  name: string;
  /** なぜ新しい業務と判定したか(1〜2文) */
  reason: string;
}

/** AI へ注入される標準コンテキストのサイズ(モデル上限に対する監視用) */
export interface ContextSize {
  /** 注入テキストの文字数 */
  chars: number;
  /** 概算トークン数(ASCII 4文字 ≈ 1、それ以外 1文字 ≈ 1 で見積り) */
  tokens: number;
  /** モデルのコンテキスト上限(CONTEXT_WINDOW_TOKENS、既定 200,000) */
  windowTokens: number;
}

/** /api/contexts 系のレスポンス(知識ベースの全体像) */
export interface KnowledgeState {
  sources: SourceMeta[];
  categories: KnowledgeCategorySummary[];
  /** AI へ注入される標準コンテキストのサイズ */
  contextSize: ContextSize;
  /** 未解消の矛盾(このビューの所有スコープ分) */
  conflicts: KnowledgeConflict[];
  /** 未処理のボード作成提案(このビューの所有スコープ分) */
  proposals: BoardProposal[];
}

/** サーバーから push されるボード同期イベント(SSE) */
export interface BoardEvent {
  type: "storymap" | "chat:start" | "chat:end" | "contexts";
  /** 対象ボード。"*" は全ボード向け(共通知識の変更など) */
  boardId: string;
  at: string;
}

/** ボード(= 業務)のメタ情報 */
export interface BoardMeta {
  id: string;
  name: string;
  createdAt: string;
}
