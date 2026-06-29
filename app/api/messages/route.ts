import { NextResponse } from "next/server";
import { clearMessages } from "@/infrastructure/storage";

export const dynamic = "force-dynamic";

// 会話履歴をクリアする(マップ・版履歴は保持)。
export async function DELETE() {
  await clearMessages();
  return NextResponse.json({ ok: true });
}
