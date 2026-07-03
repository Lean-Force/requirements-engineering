import { NextResponse } from "next/server";
import { deleteEntry, updateEntry } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";
import type { EntryPatch } from "@/contracts";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string; id: string; entryId: string };
}

// エントリ 1 件の保存(edited = true になり再抽出でも上書きされない)
export async function PATCH(request: Request, { params }: Params) {
  let body: EntryPatch;
  try {
    body = (await request.json()) as EntryPatch;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (typeof body.title !== "string" || body.title.trim() === "" ||
      typeof body.content !== "string" || body.content.trim() === "" ||
      typeof body.common !== "boolean") {
    return NextResponse.json(
      { error: "title / content / common が必要です" },
      { status: 400 },
    );
  }
  try {
    const state = await updateEntry(params.boardId, params.id, params.entryId, body);
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// エントリ 1 件の削除(資料は残る)
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const state = await deleteEntry(params.boardId, params.id, params.entryId);
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
