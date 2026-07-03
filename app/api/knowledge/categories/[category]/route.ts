import { NextResponse } from "next/server";
import { getCategoryMarkdown } from "@/infrastructure/context";
import type { KnowledgeCategory } from "@/contracts";

export const dynamic = "force-dynamic";

const CATEGORIES: KnowledgeCategory[] = [
  "terms",
  "actors",
  "flows",
  "data",
  "background",
];

interface Params {
  params: { category: string };
}

// 共通知識のカテゴリ閲覧(共通スコープのみ)
export async function GET(_request: Request, { params }: Params) {
  const category = params.category as KnowledgeCategory;
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: "指定のカテゴリが見つかりません" },
      { status: 404 },
    );
  }
  return NextResponse.json(await getCategoryMarkdown(null, category));
}
