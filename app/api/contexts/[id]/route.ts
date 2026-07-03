import { NextResponse } from "next/server";
import {
  setContextEnabled,
  deleteContext,
  getContextContent,
} from "@/infrastructure/context/store";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { id: string };
}

// 変換後の内容(Markdown)を取得(パネルでの内容確認用)
export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json(await getContextContent(params.id));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// on/off の切り替え(チーム共有の状態)
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
    const docs = await setContextEnabled(params.id, body.enabled);
    emit("contexts");
    return NextResponse.json(docs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

// 資料の削除(skill ディレクトリごと消す)
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const docs = await deleteContext(params.id);
    emit("contexts");
    return NextResponse.json(docs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
