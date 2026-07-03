import { NextResponse } from "next/server";
import {
  setSourceEnabled,
  deleteSource,
  getSourceMarkdown,
} from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string; id: string };
}

// ソースから抽出されたエントリの閲覧(出典確認用)
export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json(await getSourceMarkdown(params.boardId, params.id));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// ソースの on/off(このソース由来の知識を AI に提示するか。チーム共有の状態)
export async function PATCH(request: Request, { params }: Params) {
  let body: { enabled?: boolean };
  try {
    body = (await request.json()) as { enabled?: boolean };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled(boolean)が必要です" },
      { status: 400 },
    );
  }

  try {
    const state = await setSourceEnabled(params.boardId, params.id, body.enabled);
    // 共通知識の可能性があるため全ボードへ通知する(自ボード分の再取得は無害)
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// ソースの削除(原資料と抽出済みエントリごと消す)
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const state = await deleteSource(params.boardId, params.id);
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
