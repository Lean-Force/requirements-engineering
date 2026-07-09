// 知識ベースパッケージの公開窓口。
//   knowledge.ts  … ユースケース(取り込み・再抽出・on/off・削除・閲覧)
//   skills.ts     … カテゴリ定義と SKILL.md レンダラ(Agent Skill 化)
//   repository.ts … 永続化(JSON IO)— パッケージ内部専用
//   parse.ts      … ファイル → Markdown 変換
//   workspace.ts  … データ置き場の解決
export {
  acceptBoardProposal,
  addChatKnowledge,
  addSource,
  applyReextraction,
  applySource,
  buildBoardContext,
  buildChatContext,
  buildKnowledgeContext,
  deleteEntry,
  deleteSource,
  dismissBoardProposal,
  dismissConflict,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceEntries,
  getSourceMarkdown,
  listOwnEntries,
  proposeEntryRevision,
  recordBoardProposal,
  recordConflicts,
  reextractSource,
  syncKnowledgeSkills,
  updateEntry,
  setSourceEnabled,
} from "./knowledge";
export { removeBoardMapKnowledge, renderMapText } from "./map-skills";
export { COMMON_SCOPE, dataRoot, workspaceDir } from "./workspace";
