import { NextResponse } from "next/server";
import { acceptBoardProposal } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { proposalId: string };
}

// ボード作成提案を受け入れる(ボード作成 + 資料・知識の移動)
export async function POST(_request: Request, { params }: Params) {
  try {
    const result = await acceptBoardProposal(null, params.proposalId);
    // 資料の移動は全ボードの知識ビューに影響する
    emit("*", "contexts");
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
