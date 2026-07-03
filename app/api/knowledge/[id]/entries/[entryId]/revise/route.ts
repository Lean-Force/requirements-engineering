import { NextResponse } from "next/server";
import { isConfigured } from "@/infrastructure/agent";
import { proposeEntryRevision } from "@/infrastructure/context";

export const dynamic = "force-dynamic";
// 原資料の読み直し + LLM 呼び出し
export const maxDuration = 120;

interface Params {
  params: { id: string; entryId: string };
}

// エントリ 1 件の AI 修正案(保存はしない。適用は PATCH で行う)
export async function POST(request: Request, { params }: Params) {
  if (!isConfigured()) {
    return NextResponse.json({ error: "LLM が未設定です" }, { status: 500 });
  }
  let body: { instruction?: string };
  try {
    body = (await request.json()) as { instruction?: string };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (typeof body.instruction !== "string" || body.instruction.trim() === "") {
    return NextResponse.json(
      { error: "instruction(修正指示)が必要です" },
      { status: 400 },
    );
  }
  try {
    const revision = await proposeEntryRevision(
      null,
      params.id,
      params.entryId,
      body.instruction,
    );
    return NextResponse.json(revision);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("見つかりません") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
