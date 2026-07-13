import { NextResponse } from "next/server";
import { getBoard } from "@/infrastructure/boards";
import {
  deleteDiscussion,
  reopenDiscussion,
  resolveDiscussion,
} from "@/infrastructure/discussions";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string; discussionId: string };
}

// 論点の状態変更: 解決(結論必須)または未解決へ戻す
export async function PATCH(request: Request, { params }: Params) {
  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json({ error: "指定のボードが見つかりません" }, { status: 404 });
  }

  let body: { action?: "resolve" | "reopen"; resolution?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  try {
    if (body.action === "resolve") {
      if (typeof body.resolution !== "string" || body.resolution.trim() === "") {
        return NextResponse.json(
          { error: "解決には resolution(結論と理由)が必要です" },
          { status: 400 },
        );
      }
      const point = await resolveDiscussion(
        params.boardId,
        params.discussionId,
        body.resolution,
      );
      emit(params.boardId, "discussions");
      return NextResponse.json(point);
    }
    if (body.action === "reopen") {
      const point = await reopenDiscussion(params.boardId, params.discussionId);
      emit(params.boardId, "discussions");
      return NextResponse.json(point);
    }
    return NextResponse.json(
      { error: "action(resolve | reopen)が必要です" },
      { status: 400 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// 論点の削除
export async function DELETE(_request: Request, { params }: Params) {
  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json({ error: "指定のボードが見つかりません" }, { status: 404 });
  }
  try {
    await deleteDiscussion(params.boardId, params.discussionId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
  emit(params.boardId, "discussions");
  return NextResponse.json({ ok: true });
}
