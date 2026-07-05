// ドメイン知識の「AI 向けビュー」の部品。
//
// 知識は system prompt へ全文注入される(knowledge.ts の buildKnowledgeContext)。
// このモジュールはカテゴリ定義と、カテゴリ本文の共通描画(閲覧 UI とプロンプトで共用)
// だけを持つ。かつての Agent Skill(SKILL.md)機構は撤去済み。

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
 * labelOf は「有効なソース id → 出典表示名」。閲覧 UI とプロンプト注入の共通描画。
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
