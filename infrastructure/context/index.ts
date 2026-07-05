// 知識ベースパッケージの公開窓口。
//   knowledge.ts  … ユースケース(取り込み・再抽出・on/off・削除・閲覧)
//   skills.ts     … カテゴリ定義とカテゴリ本文の共通描画(プロンプト注入の部品)
//   repository.ts … 永続化(JSON IO)— パッケージ内部専用
//   parse.ts      … ファイル → Markdown 変換
//   workspace.ts  … データ置き場の解決
export {
  acceptBoardProposal,
  addSource,
  buildBoardContext,
  buildKnowledgeContext,
  deleteEntry,
  deleteSource,
  dismissBoardProposal,
  dismissConflict,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceEntries,
  getSourceMarkdown,
  proposeEntryRevision,
  reextractSource,
  updateEntry,
  setSourceEnabled,
} from "./knowledge";
export { removeBoardMapKnowledge, renderMapText } from "./map-skills";
export { COMMON_SCOPE, dataRoot, workspaceDir } from "./workspace";
