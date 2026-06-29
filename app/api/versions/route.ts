import { NextResponse } from "next/server";
import { listVersions, restoreVersion } from "@/infrastructure/storage";

export const dynamic = "force-dynamic";

// 版の一覧(メタ)を返す。
export async function GET() {
  const versions = await listVersions();
  return NextResponse.json(versions);
}

// 指定 id の版を現在のマップに復元する。
export async function POST(request: Request) {
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
    const result = await restoreVersion(body.id);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
