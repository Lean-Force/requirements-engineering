// 知識ベースパッケージの公開窓口。
//   knowledge.ts  … ユースケース(取り込み・再抽出・on/off・削除・閲覧)
//   skills.ts     … AI 向けビュー(SKILL.md)のレンダリングとチャット準備
//   repository.ts … 永続化(JSON IO)— パッケージ内部専用
//   parse.ts      … ファイル → Markdown 変換
//   workspace.ts  … データ置き場の解決
export {
  addSource,
  deleteSource,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceMarkdown,
  reextractSource,
  setSourceEnabled,
} from "./knowledge";
export { prepareSkillsForChat } from "./skills";
export { COMMON_SCOPE, dataRoot, workspaceDir } from "./workspace";
