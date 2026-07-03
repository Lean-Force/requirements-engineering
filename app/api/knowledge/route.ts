import { NextResponse } from "next/server";
import { addSource, getKnowledgeState } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";
// 取り込み時に LLM でドメイン知識を抽出するため余裕を持たせる
export const maxDuration = 300;

// 共通知識(業務横断)の全体像。ボードを開かずに GLOBAL を管理するための入口。
export async function GET() {
  return NextResponse.json(await getKnowledgeState(null));
}

// 共通知識としてのアップロード(multipart/form-data。常に共通スコープへ)
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "multipart/form-data で送信してください" },
      { status: 400 },
    );
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
  }

  try {
    let state = await getKnowledgeState(null);
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      state = await addSource(null, file.name, buffer);
    }
    emit("*", "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
