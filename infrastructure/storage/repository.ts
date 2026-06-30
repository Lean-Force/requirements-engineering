import type { BoardSession } from "@/contracts";

// 永続化ポート(保存先の抽象)。
// 保存単位は「1 セッション(マップ + 会話 + 版履歴)」。保存先(ローカルFS)は
// この I/F の裏に隠す。版の上限や重複排除などの方針は上位(storage/index.ts)に置き、
// 実装はセッションの read/write だけに責任を持つ。
export interface StoryMapRepository {
  // 保存済みセッションを返す。未保存なら空セッションを返す(throw しない)。
  loadSession(): Promise<BoardSession>;
  // セッション全体を保存する。
  saveSession(session: BoardSession): Promise<void>;
}
