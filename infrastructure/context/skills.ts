// ドメイン知識の「AI 向けビュー」= Agent Skill(SKILL.md)のレンダリング。
//
// カテゴリごとに 1 skill を生成し、description にエントリのタイトル一覧を入れる
// (AI が読む/読まないを決める唯一の手がかり)。
//
// スコープはエントリ単位(KnowledgeEntry.common)。資料はアップロードした場所
// (ボード or 共通管理画面)に属し、抽出された各エントリを AI が
// 業務固有 / 業務横断に自動判定する:
//   kb-<cat>        … ボードの業務固有エントリ(common = false)
//   kb-common-<cat> … 全スコープの共通エントリ(common = true)を _common に合成
// kb-common-* はチャット直前に各ボードのワークスペースへ同期コピーされる。

import { promises as fs } from "fs";
import path from "path";
import type { KnowledgeCategory, KnowledgeEntry } from "@/contracts";
import { listBoards } from "../boards";
import { readEntries, readSources, skillsRoot } from "./repository";
import { COMMON_SCOPE } from "./workspace";

// カテゴリの定義(表示名・「いつ読むか」のヒント)
export const CATEGORIES: {
  category: KnowledgeCategory;
  label: string;
  whenToRead: string;
}[] = [
  { category: "terms", label: "用語集", whenToRead: "用語・概念の意味や定義を確認するとき" },
  { category: "actors", label: "アクター", whenToRead: "登場人物・役割・システムの責務を確認するとき" },
  { category: "flows", label: "業務フロー・ルール", whenToRead: "業務の流れ・順序・条件分岐・承認ルールを確認するとき" },
  { category: "data", label: "データ・IF定義", whenToRead: "データ項目・インターフェース・値域などの制約を確認するとき" },
  { category: "background", label: "背景・課題", whenToRead: "背景・目的・課題・ユーザーの要望を踏まえるとき" },
];

export function skillName(category: KnowledgeCategory, scope: string): string {
  return scope === COMMON_SCOPE ? `kb-common-${category}` : `kb-${category}`;
}

/**
 * カテゴリ本文(有効ソース由来のエントリを出典付きで並べる)。
 * labelOf は「有効なソース id → 出典表示名」。閲覧 UI と SKILL.md の共通描画。
 */
export function renderCategoryBody(
  category: KnowledgeCategory,
  labelOf: Map<string, string>,
  entries: KnowledgeEntry[],
): string {
  const list = entries.filter(
    (e) => e.category === category && labelOf.has(e.sourceId),
  );
  return list
    .map(
      (e) =>
        `## ${e.title}\n\n${e.content}\n\n_出典: ${labelOf.get(e.sourceId)}_`,
    )
    .join("\n\n");
}

/** スコープの有効ソースの表示名マップ(ソース id → ファイル名)を作る */
async function enabledLabels(scope: string): Promise<Map<string, string>> {
  const sources = await readSources(scope);
  return new Map(sources.filter((s) => s.enabled).map((s) => [s.id, s.fileName]));
}

/**
 * ボードの業務固有知識(common = false)のカテゴリ別 SKILL.md を再レンダリングする。
 * 共通知識側(kb-common-*)は renderCommonSkills が担う。
 */
export async function renderSkills(boardId: string): Promise<void> {
  const labelOf = await enabledLabels(boardId);
  const entries = (await readEntries(boardId)).filter((e) => !e.common);
  await renderCategorySkills(boardId, labelOf, entries, false);
}

/**
 * 業務横断の共通知識(全スコープの common = true エントリ)を _common の
 * kb-common-* へ合成する。どのボードの知識が変わっても呼び直す。
 */
export async function renderCommonSkills(): Promise<void> {
  const scopes = [COMMON_SCOPE, ...(await listBoards()).map((b) => b.id)];
  const labelOf = new Map<string, string>();
  const entries: KnowledgeEntry[] = [];
  for (const scope of scopes) {
    for (const [id, label] of await enabledLabels(scope)) labelOf.set(id, label);
    entries.push(...(await readEntries(scope)).filter((e) => e.common));
  }
  await renderCategorySkills(COMMON_SCOPE, labelOf, entries, true);
}

/** カテゴリごとに SKILL.md を書き出す(空カテゴリの skill は残さない) */
async function renderCategorySkills(
  scope: string,
  labelOf: Map<string, string>,
  entries: KnowledgeEntry[],
  isCommon: boolean,
): Promise<void> {
  for (const c of CATEGORIES) {
    const list = entries.filter(
      (e) => e.category === c.category && labelOf.has(e.sourceId),
    );
    const name = skillName(c.category, scope);
    const dir = path.join(skillsRoot(scope), name);

    if (list.length === 0) {
      // 空カテゴリの skill は残さない(AI に空の選択肢を見せない)
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }

    // description にタイトル一覧を入れる(AI が読む/読まないを決める手がかり)。
    // skill 仕様の description 上限(1024 文字)に収まるよう切り詰める。
    const titles = truncateList(list.map((e) => e.title), 700);
    const prefix = isCommon ? "業務横断の共通知識" : "この業務のドメイン知識";
    const description = `${prefix}: ${c.label}(${titles})。${c.whenToRead}に読むこと。`;

    const body = renderCategoryBody(c.category, labelOf, list);
    const skillMd = `---
name: ${name}
description: ${oneLine(description)}
---

# ${c.label}${isCommon ? "(業務横断)" : ""}

${body}
`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
  }
}

/**
 * チャット直前の準備: 共通知識の skill をボードのワークスペースへ同期コピーし、
 * query() の skills オプションへ渡す skill 名一覧(ボード + 共通)を返す。
 */
export async function prepareSkillsForChat(boardId: string): Promise<string[]> {
  const names: string[] = [];

  // ボード自身の業務固有知識
  const labelOf = await enabledLabels(boardId);
  const boardEntries = (await readEntries(boardId)).filter((e) => !e.common);
  for (const c of CATEGORIES) {
    if (
      boardEntries.some(
        (e) => e.category === c.category && labelOf.has(e.sourceId),
      )
    ) {
      names.push(skillName(c.category, boardId));
    }
  }

  // 共通知識: _common の kb-common-* をボードのワークスペースへ同期コピー
  const boardSkills = skillsRoot(boardId);
  await fs.mkdir(boardSkills, { recursive: true });
  for (const entry of await fs.readdir(boardSkills).catch(() => [] as string[])) {
    if (entry.startsWith("kb-common-")) {
      await fs.rm(path.join(boardSkills, entry), { recursive: true, force: true });
    }
  }
  const commonSkills = skillsRoot(COMMON_SCOPE);
  for (const entry of await fs.readdir(commonSkills).catch(() => [] as string[])) {
    if (!entry.startsWith("kb-common-")) continue;
    await fs.cp(path.join(commonSkills, entry), path.join(boardSkills, entry), {
      recursive: true,
    });
    names.push(entry);
  }

  return names;
}

// ---- 内部 ----------------------------------------------------------------

function truncateList(items: string[], maxChars: number): string {
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
