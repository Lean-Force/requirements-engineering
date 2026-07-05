import { NextResponse } from "next/server";
import { isConfigured, refineCard } from "@/infrastructure/agent";
import { buildBoardContext } from "@/infrastructure/context";
import { getBoard } from "@/infrastructure/boards";
import type { RefineRequest } from "@/contracts";

export const dynamic = "force-dynamic";
// 用語合わせのためにドメイン知識を読むことがある
export const maxDuration = 120;

interface Params {
  params: { boardId: string };
}

// 付箋(行動 / ストーリー)の AI 校正。マップは変更しない(提案を返すだけ)ため
// チャットのミューテックスは通さない。
export async function POST(request: Request, { params }: Params) {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: "LLM が未設定です。サーバーの環境変数を確認してください。" },
      { status: 500 },
    );
  }

  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json(
      { error: "指定のボードが見つかりません" },
      { status: 404 },
    );
  }

  let body: RefineRequest;
  try {
    body = (await request.json()) as RefineRequest;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (
    (body.kind !== "action" && body.kind !== "story") ||
    typeof body.text !== "string" ||
    body.text.trim() === ""
  ) {
    return NextResponse.json(
      { error: "kind(action | story)と text が必要です" },
      { status: 400 },
    );
  }

  try {
    // 標準コンテキストブロック(現在のマップ含む)を注入する(場面の粒度・言い回しとの整合)
    const boardContext = await buildBoardContext(params.boardId);
    const result = await refineCard(params.boardId, body, boardContext);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
