// ドメイン知識の「AI 向けビュー」= Agent Skill(SKILL.md)のレンダリング。
//
// カテゴリごとに 1 skill を生成し、description にエントリのタイトル一覧を入れる
// (AI が読む/読まないを決める唯一の手がかり)。共通知識(_common)は
// kb-common-* という名前でレンダリングされ、チャット直前に各ボードへ同期される。

import { promises as fs } from "fs";
import path from "path";
import type {
  KnowledgeCategory,
  KnowledgeEntry,
  SourceMeta,
} from "@/contracts";
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

/** カテゴリ本文(有効ソース由来のエントリを出典付きで並べる)。閲覧 UI と SKILL.md の共通描画 */
export function renderCategoryBody(
  category: KnowledgeCategory,
  sources: SourceMeta[],
  entries: KnowledgeEntry[],
): string {
  const enabled = new Map(
    sources
      .filter((s) => s.enabled)
      .map((s) => [
        s.id,
        s.scope === "common" ? `${s.fileName}(共通)` : s.fileName,
      ]),
  );
  const list = entries.filter(
    (e) => e.category === category && enabled.has(e.sourceId),
  );
  return list
    .map(
      (e) =>
        `## ${e.title}\n\n${e.content}\n\n_出典: ${enabled.get(e.sourceId)}_`,
    )
    .join("\n\n");
}

/** スコープのカテゴリ別 SKILL.md を再レンダリングする */
export async function renderSkills(scope: string): Promise<void> {
  const sources = (await readSources(scope)).map((s) => ({
    ...s,
    scope: (scope === COMMON_SCOPE ? "common" : "board") as SourceMeta["scope"],
  }));
  const entries = await readEntries(scope);
  const enabledIds = new Set(sources.filter((s) => s.enabled).map((s) => s.id));
  const isCommon = scope === COMMON_SCOPE;

  for (const c of CATEGORIES) {
    const list = entries.filter(
      (e) => e.category === c.category && enabledIds.has(e.sourceId),
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

    const body = renderCategoryBody(c.category, sources, entries);
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

  // ボード自身の知識
  const boardSources = await readSources(boardId);
  const boardEntries = await readEntries(boardId);
  const boardEnabled = new Set(
    boardSources.filter((s) => s.enabled).map((s) => s.id),
  );
  for (const c of CATEGORIES) {
    if (
      boardEntries.some(
        (e) => e.category === c.category && boardEnabled.has(e.sourceId),
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
