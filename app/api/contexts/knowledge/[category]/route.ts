import { NextResponse } from "next/server";
import { getCategoryMarkdown } from "@/infrastructure/context/store";
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

// カテゴリの知識(有効ソース由来)を閲覧用 Markdown で返す
export async function GET(_request: Request, { params }: Params) {
  const category = params.category as KnowledgeCategory;
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: "指定のカテゴリが見つかりません" },
      { status: 404 },
    );
  }
  return NextResponse.json(await getCategoryMarkdown(category));
}
