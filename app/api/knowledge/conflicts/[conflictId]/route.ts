import { NextResponse } from "next/server";
import { dismissConflict } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

interface Params {
  params: { conflictId: string };
}

// 矛盾を解決済みにする(一覧から消す)
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const state = await dismissConflict(null, params.conflictId);
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
