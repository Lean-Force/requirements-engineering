import { NextResponse } from "next/server";
import { loadSession } from "@/infrastructure/storage";

export const dynamic = "force-dynamic";

// 初期ロード用: 現在のマップ・会話・版一覧(メタ)をまとめて返す。
export async function GET() {
  const session = await loadSession();
  return NextResponse.json(session);
}
