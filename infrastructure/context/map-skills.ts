// マップ(story / バックボーン)の「AI 向けビュー」。
//
// マップ自体もドメイン知識である、という位置づけ:
//   - 確定(fixed)済みの行動・ストーリーは「チームが合意した決定 + なぜなら(理由)」
//   - バックボーンは「業務の流れそのもの」
// 知識は system prompt へ全文注入される(buildKnowledgeContext)。このモジュールは
// その材料になる「確定済みマップの断片」を保存時にキャッシュする:
//   _common/map-snippets/<boardId>.md … 各業務の確定済み要素だけの Markdown
// (プロンプト構築時に他ボードのマップ全体を読み直さずに済む)

import { promises as fs } from "fs";
import path from "path";
import type { Action, StoryMap } from "@/domain";
import { listBoards } from "../boards";
import { COMMON_SCOPE, workspaceDir } from "./workspace";

const snippetsDir = () => path.join(workspaceDir(COMMON_SCOPE), "map-snippets");
const snippetFile = (boardId: string) => path.join(snippetsDir(), `${boardId}.md`);

/** マップ保存時のエントリポイント: 確定済み断片のキャッシュを更新する */
export async function renderMapKnowledge(
  boardId: string,
  map: StoryMap,
): Promise<void> {
  const scenes = sceneLines(map, { fixedOnly: true });
  if (scenes.length === 0) {
    await fs.rm(snippetFile(boardId), { force: true });
    return;
  }
  await fs.mkdir(snippetsDir(), { recursive: true });
  await fs.writeFile(snippetFile(boardId), scenes.join("\n\n"), "utf-8");
}

/** ボード削除時: 断片を消す */
export async function removeBoardMapKnowledge(boardId: string): Promise<void> {
  await fs.rm(snippetFile(boardId), { force: true });
}

/**
 * 全ボードの確定済みマップ断片(業務名つき)。プロンプト注入用。
 * ボード削除後の取り残し(orphan)はここで掃除する。
 */
export async function confirmedMapSections(): Promise<
  { name: string; body: string }[]
> {
  const nameOf = new Map((await listBoards()).map((b) => [b.id, b.name]));
  const sections: { name: string; body: string }[] = [];
  for (const file of await fs.readdir(snippetsDir()).catch(() => [] as string[])) {
    if (!file.endsWith(".md")) continue;
    const boardId = file.slice(0, -3);
    if (!nameOf.has(boardId)) {
      await fs.rm(path.join(snippetsDir(), file), { force: true });
      continue;
    }
    sections.push({
      name: nameOf.get(boardId)!,
      body: await fs.readFile(path.join(snippetsDir(), file), "utf-8"),
    });
  }
  return sections;
}

/** マップ全体を Markdown にする(付箋の AI 校正などがプロンプトに使う) */
export function renderMapText(map: StoryMap): string {
  const scenes = sceneLines(map, { fixedOnly: false });
  if (scenes.length === 0) return "";
  return [
    `アクター: ${map.actors.map((a) => a.name).join(" / ") || "(未定義)"}`,
    "【確定】が付いた行動・ストーリーはチーム合意済みの決定。",
    ...scenes,
  ].join("\n\n");
}

// ---- 内部: マップ → Markdown -----------------------------------------------

/**
 * 場面ごとの Markdown を組み立てる。
 * fixedOnly = true では確定済みの行動/ストーリーだけを残す
 * (未確定の行動の下の確定ストーリーは、文脈として行動ごと載せる)。
 */
function sceneLines(
  map: StoryMap,
  { fixedOnly }: { fixedOnly: boolean },
): string[] {
  const actorName = new Map(map.actors.map((a) => [a.id, a.name]));
  const lines: string[] = [];

  map.activities.forEach((activity, i) => {
    const actions = activity.actions.filter((action) =>
      fixedOnly ? action.fixed || action.stories.some((s) => s.fixed) : true,
    );
    if (actions.length === 0) return;

    const body = actions
      .map((action) => actionLines(action, actorName, fixedOnly))
      .join("\n");
    lines.push(`### 場面${i + 1}\n${body}`);
  });
  return lines;
}

function actionLines(
  action: Action,
  actorName: Map<string, string>,
  fixedOnly: boolean,
): string {
  const mark = (fixed?: boolean) => (fixed ? "【確定】" : "");
  const stories = action.stories.filter((s) => (fixedOnly ? s.fixed : true));
  const storyLines = stories.map((s) => `  - ${mark(s.fixed)}${s.text}`);
  return [
    `- ${mark(action.fixed)}${actorName.get(action.actorId) ?? "?"}「${action.text}」`,
    ...storyLines,
  ].join("\n");
}
