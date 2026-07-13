import { NextResponse } from "next/server";
import { getBoard } from "@/infrastructure/boards";
import { addDiscussion, listDiscussions } from "@/infrastructure/discussions";
import { emit } from "@/infrastructure/events";
import type { DiscussionTarget } from "@/contracts";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string };
}

const KINDS: DiscussionTarget["kind"][] = ["story", "action", "activity", "board"];

// 論点の一覧(要素削除で宙に浮いた論点はここで掃除される)
export async function GET(_request: Request, { params }: Params) {
  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json({ error: "指定のボードが見つかりません" }, { status: 404 });
  }
  return NextResponse.json(await listDiscussions(params.boardId));
}

// 論点の追加(手動のみ。AI からは追加できない)
export async function POST(request: Request, { params }: Params) {
  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json({ error: "指定のボードが見つかりません" }, { status: 404 });
  }

  let body: { target?: DiscussionTarget; text?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  const { target, text } = body;
  if (
    !target ||
    !KINDS.includes(target.kind) ||
    typeof target.id !== "string" ||
    target.id === "" ||
    typeof text !== "string" ||
    text.trim() === ""
  ) {
    return NextResponse.json(
      { error: "target(kind, id)と text が必要です" },
      { status: 400 },
    );
  }

  const point = await addDiscussion(params.boardId, target, text);
  emit(params.boardId, "discussions");
  return NextResponse.json(point);
}
