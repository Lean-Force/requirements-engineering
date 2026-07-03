import { NextResponse } from "next/server";
import { clearMessages } from "@/infrastructure/storage";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string };
}

// 会話履歴をクリアする(マップ・版履歴は保持)。
export async function DELETE(_request: Request, { params }: Params) {
  await clearMessages(params.boardId);
  return NextResponse.json({ ok: true });
}
