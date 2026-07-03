import { NextResponse } from "next/server";
import { moveSource } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string; id: string };
}

// 資料を業務 ⇄ 共通の間で移動する(振り分けミスの修正)
export async function POST(request: Request, { params }: Params) {
  let body: { common?: boolean };
  try {
    body = (await request.json()) as { common?: boolean };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (typeof body.common !== "boolean") {
    return NextResponse.json(
      { error: "common(boolean)が必要です" },
      { status: 400 },
    );
  }

  try {
    const state = await moveSource(params.boardId, params.id, body.common);
    // 共通が絡むため全ボードへ通知する
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
