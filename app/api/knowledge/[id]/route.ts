import { NextResponse } from "next/server";
import {
  deleteSource,
  getSourceMarkdown,
  setSourceEnabled,
} from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { id: string };
}

// 共通知識ソースの抽出結果を閲覧(出典確認用)
export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json(await getSourceMarkdown(null, params.id));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// 共通知識ソースの on/off
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
    const state = await setSourceEnabled(null, params.id, body.enabled);
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// 共通知識ソースの削除
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const state = await deleteSource(null, params.id);
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
