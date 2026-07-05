import { NextResponse } from "next/server";
import { renameBoard, deleteBoard } from "@/infrastructure/boards";
import { removeBoardMapKnowledge } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string };
}

// ボード名(業務名)の変更
export async function PATCH(request: Request, { params }: Params) {
  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  try {
    const board = await renameBoard(params.boardId, body.name ?? "");
    // 業務名はプロンプト構築時に解決されるため、再レンダリングは不要
    emit("*", "contexts");
    return NextResponse.json(board);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("見つかりません") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

// ボードの削除(マップ・会話・版履歴・ドメイン知識ごと。確定マップ断片も掃除)
export async function DELETE(_request: Request, { params }: Params) {
  try {
    await deleteBoard(params.boardId);
    await removeBoardMapKnowledge(params.boardId);
    emit("*", "contexts");
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
