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

/**
 * アップロードされた参照資料(コンテキスト)1 件のメタ情報。
 * 1 ファイル = 1 件。実体は Agent Skill(SKILL.md)としてワークスペースに
 * 保存され、AI が必要と判断したときだけ本文を読む(progressive disclosure)。
 * Excel の複数シートは SKILL.md 内のセクションとして保持される。
 */
export interface ContextDocMeta {
  /** skill 名を兼ねる(ディレクトリ名 = SKILL.md の name) */
  id: string;
  fileName: string;
  /** AI に常駐提示される 1 行説明 */
  description: string;
  /** プロンプトに含めるか(チーム共有の状態) */
  enabled: boolean;
  charCount: number;
  uploadedAt: string;
}

/** サーバーから push されるボード同期イベント(SSE) */
export interface BoardEvent {
  type: "storymap" | "chat:start" | "chat:end" | "contexts";
  at: string;
}
