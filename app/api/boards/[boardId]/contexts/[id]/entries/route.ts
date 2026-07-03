import { NextResponse } from "next/server";
import { getSourceEntries } from "@/infrastructure/context";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string; id: string };
}

// ソース 1 件の抽出エントリ一覧(編集 UI 用)
export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json(await getSourceEntries(params.boardId, params.id));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
