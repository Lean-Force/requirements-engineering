import { NextResponse } from "next/server";
import { listVersions, restoreVersion } from "@/infrastructure/storage";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string };
}

// 版の一覧(メタ)を返す。
export async function GET(_request: Request, { params }: Params) {
  const versions = await listVersions(params.boardId);
  return NextResponse.json(versions);
}

// 指定 id の版を現在のマップに復元する。
export async function POST(request: Request, { params }: Params) {
  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: "id が必要です" }, { status: 400 });
  }

  try {
    const result = await restoreVersion(params.boardId, body.id);
    emit(params.boardId, "storymap");
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
