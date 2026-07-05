import { NextResponse } from "next/server";
import { getKnowledgeState } from "@/infrastructure/context";

export const dynamic = "force-dynamic";

// 共通知識(業務横断)の集約ビュー。資料のアップロード口は各ボードの知識パネル
// だけ(一本化)なので、ここは GET のみ。
export async function GET() {
  return NextResponse.json(await getKnowledgeState(null));
}
