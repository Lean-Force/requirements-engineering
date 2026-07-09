// ドメイン知識の「AI 向けビュー」= Agent Skill(SKILL.md)。
//
// 知識はカテゴリごとに kb-<category> skill としてボードのワークスペース
// (.claude/skills/)へレンダリングされ、チャット直前に同期される。
// description(いつ読むか + 収録タイトル一覧)は常駐提示され、本文は AI が
// 必要と判断したときだけ読まれる(progressive disclosure)。
// 同期のエントリポイントは knowledge.ts の syncKnowledgeSkills(ビューを持つため)。

import { promises as fs } from "fs";
import path from "path";
import type { KnowledgeCategory, KnowledgeEntry } from "@/contracts";

// カテゴリの定義(表示名・「いつ使うか」のヒント)
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

/**
 * カテゴリ本文(有効ソース由来のエントリを出典付きで並べる)。
 * labelOf は「有効なソース id → 出典表示名」。閲覧 UI と SKILL.md で共用。
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

/** skill 名(= ディレクトリ名) */
export const skillName = (category: KnowledgeCategory): string => `kb-${category}`;

// description の上限は 1536 字(SKILL.md frontmatter の仕様)。余裕を持って抑える
const DESCRIPTION_MAX = 1024;

/**
 * カテゴリ 1 つを SKILL.md へ描画する(エントリが無ければ null)。
 * description には「いつ読むか」と収録エントリのタイトル一覧を入れる
 * (常駐提示されるトリガー情報。本文を読むかの判断材料になる)。
 */
export function renderSkill(
  category: KnowledgeCategory,
  labelOf: Map<string, string>,
  entries: KnowledgeEntry[],
): { name: string; markdown: string } | null {
  const def = CATEGORIES.find((c) => c.category === category);
  if (!def) return null;
  const body = renderCategoryBody(category, labelOf, entries);
  if (!body) return null;

  const titles = entries
    .filter((e) => e.category === category && labelOf.has(e.sourceId))
    .map((e) => e.title);
  const head = `${def.label}のドメイン知識。${def.whenToRead}に読む。収録: `;
  let list = titles.join(" / ");
  let omitted = 0;
  while (titles.length - omitted > 1 && head.length + list.length + 12 > DESCRIPTION_MAX) {
    omitted++;
    list = titles.slice(0, titles.length - omitted).join(" / ");
  }
  const description = `${head}${list}${omitted > 0 ? ` …他${omitted}件` : ""}`;

  const markdown = `---
name: ${skillName(category)}
description: "${description.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"
---

# ${def.label}

${body}
`;
  return { name: skillName(category), markdown };
}

/**
 * skills ディレクトリを目的の集合へ同期する:
 * 対象 skill を書き込み、それ以外の kb-* ディレクトリ(空カテゴリ・旧機構の残骸)は消す。
 */
export async function syncSkillsDir(
  skillsRoot: string,
  skills: { name: string; markdown: string }[],
): Promise<void> {
  await fs.mkdir(skillsRoot, { recursive: true });

  const keep = new Set(skills.map((s) => s.name));
  for (const entry of await fs.readdir(skillsRoot).catch(() => [] as string[])) {
    if (entry.startsWith("kb-") && !keep.has(entry)) {
      await fs.rm(path.join(skillsRoot, entry), { recursive: true, force: true });
    }
  }

  for (const skill of skills) {
    const dir = path.join(skillsRoot, skill.name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), skill.markdown, "utf-8");
  }
}
