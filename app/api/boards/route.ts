import { NextResponse } from "next/server";
import { listBoards, createBoard } from "@/infrastructure/boards";

export const dynamic = "force-dynamic";

// ボード(= 業務)の一覧
export async function GET() {
  return NextResponse.json(await listBoards());
}

// ボードの作成
export async function POST(request: Request) {
  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  try {
    const board = await createBoard(body.name ?? "");
    return NextResponse.json(board);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
