import { NextResponse } from "next/server";
import { reextractSource } from "@/infrastructure/context/store";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";
// LLM での再抽出に時間がかかることがある
export const maxDuration = 300;

interface Params {
  params: { boardId: string; id: string };
}

// 保存済みの原ファイルからドメイン知識を再抽出する
export async function POST(_request: Request, { params }: Params) {
  try {
    const state = await reextractSource(params.boardId, params.id);
    // 共通知識の可能性があるため全ボードへ通知する
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("見つかりません") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
