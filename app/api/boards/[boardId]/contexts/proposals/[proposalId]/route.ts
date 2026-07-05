import { NextResponse } from "next/server";
import { dismissBoardProposal } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string; proposalId: string };
}

// ボード作成提案を却下する
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const state = await dismissBoardProposal(params.boardId, params.proposalId);
    emit(params.boardId, "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
