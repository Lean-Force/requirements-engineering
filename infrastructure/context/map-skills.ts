// マップ(story / バックボーン)の「AI 向けビュー」= Agent Skill のレンダリング。
//
// マップ自体もドメイン知識である、という位置づけ:
//   - 確定(fixed)済みの行動・ストーリーは「チームが合意した決定 + なぜなら(理由)」
//   - バックボーンは「業務の流れそのもの」
// マップが正、skill は描画ビュー(knowledge.json → kb-* と同じ思想)。保存のたびに作り直す。
//
//   kb-map(ボード内向け)       … マップ全体(未確定含む・確定マーク付き)。
//                                  付箋の AI 校正などが参照する。チャットには渡さない
//                                  (チャットは最新マップを会話にインラインで受け取るため重複)。
//   kb-common-maps(業務横断)   … 各業務の「確定済み」要素だけの合成。全ボードのチャットが
//                                  他業務の合意済みの流れ・決定を参照できる。
//
// 合成のために各ボードの確定済み断片を _common/map-snippets/<boardId>.md にキャッシュする
// (storage がマップ保存時に自ボード分だけ更新すれば、他ボードのマップを読み直さずに済む)。

import { promises as fs } from "fs";
import path from "path";
import type { Action, StoryMap } from "@/domain";
import { listBoards } from "../boards";
import { skillsRoot } from "./repository";
import { COMMON_SCOPE, workspaceDir } from "./workspace";

const snippetsDir = () => path.join(workspaceDir(COMMON_SCOPE), "map-snippets");
const snippetFile = (boardId: string) => path.join(snippetsDir(), `${boardId}.md`);

/** マップ保存時のエントリポイント: ボード内向け kb-map と業務横断 kb-common-maps を更新する */
export async function renderMapKnowledge(
  boardId: string,
  map: StoryMap,
): Promise<void> {
  await renderBoardMapSkill(boardId, map);
  await updateCommonMapSnippet(boardId, map);
  await renderCommonMapsSkill();
}

/** ボード削除時: 断片を消して合成を作り直す */
export async function removeBoardMapKnowledge(boardId: string): Promise<void> {
  await fs.rm(snippetFile(boardId), { force: true });
  await renderCommonMapsSkill();
}

/** ボードの kb-map skill が存在すれば ["kb-map"] を返す(query の skills に足す用) */
export async function boardMapSkillNames(boardId: string): Promise<string[]> {
  try {
    await fs.access(path.join(skillsRoot(boardId), "kb-map", "SKILL.md"));
    return ["kb-map"];
  } catch {
    return [];
  }
}

// ---- kb-map(ボード内向け: マップ全体) -------------------------------------

async function renderBoardMapSkill(
  boardId: string,
  map: StoryMap,
): Promise<void> {
  const dir = path.join(skillsRoot(boardId), "kb-map");
  const scenes = sceneLines(map, { fixedOnly: false });
  if (scenes.length === 0) {
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }

  const sceneTitles = truncate(
    map.activities.map((a) => a.actions.map((x) => x.text).join("・")).filter(Boolean),
    500,
  );
  const skillMd = `---
name: kb-map
description: この業務の現在の User Story Map(場面: ${oneLine(sceneTitles)})。マップの現状、確定済み(チーム合意)の行動・ストーリーとその理由、既存の場面や言い回しとの整合を確認するときに読むこと。
---

# この業務の User Story Map(現在のマップ)

アクター: ${map.actors.map((a) => a.name).join(" / ") || "(未定義)"}

【確定】が付いた行動・ストーリーはチーム合意済みの決定(変更には確定解除が必要)。

${scenes.join("\n\n")}
`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
}

// ---- kb-common-maps(業務横断: 確定済みのみの合成) --------------------------

async function updateCommonMapSnippet(
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

/** 全ボードの確定済み断片を kb-common-maps に合成する(断片が無ければ skill ごと消す) */
export async function renderCommonMapsSkill(): Promise<void> {
  const dir = path.join(skillsRoot(COMMON_SCOPE), "kb-common-maps");
  const boards = await listBoards();
  const nameOf = new Map(boards.map((b) => [b.id, b.name]));

  const sections: string[] = [];
  const names: string[] = [];
  const files = await fs.readdir(snippetsDir()).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const boardId = file.slice(0, -3);
    if (!nameOf.has(boardId)) {
      // ボード削除後の取り残し(orphan)は掃除する
      await fs.rm(path.join(snippetsDir(), file), { force: true });
      continue;
    }
    const body = await fs.readFile(path.join(snippetsDir(), file), "utf-8");
    names.push(nameOf.get(boardId)!);
    sections.push(`## 業務: ${nameOf.get(boardId)}\n\n${body}`);
  }

  if (sections.length === 0) {
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }

  const skillMd = `---
name: kb-common-maps
description: 各業務の合意済み(確定)バックボーンとストーリー(業務: ${oneLine(truncate(names, 300))})。他業務の確定済みの流れ・決定や、業務間の連携・前後関係を確認するときに読むこと。
---

# 各業務の合意済みマップ(業務横断)

各業務の User Story Map のうち、チームが確定(合意)した行動とストーリーの抜粋。
ストーリーの「なぜなら」以降は合意された理由(rationale)。

${sections.join("\n\n")}
`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
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

function truncate(items: string[], maxChars: number): string {
  const out: string[] = [];
  let total = 0;
  for (const item of items) {
    if (total + item.length > maxChars) {
      out.push(`ほか${items.length - out.length}件`);
      break;
    }
    out.push(item);
    total += item.length + 3;
  }
  return out.join(" / ");
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}
