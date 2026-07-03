import { NextResponse } from "next/server";
import { loadSession } from "@/infrastructure/storage";
import { getBoard } from "@/infrastructure/boards";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string };
}

// 初期ロード用: ボードのメタ + マップ・会話・版一覧(メタ)をまとめて返す。
export async function GET(_request: Request, { params }: Params) {
  try {
    const board = await getBoard(params.boardId);
    const session = await loadSession(params.boardId);
    return NextResponse.json({ board, ...session });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
