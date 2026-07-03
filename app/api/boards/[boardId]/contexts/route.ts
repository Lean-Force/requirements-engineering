import { NextResponse } from "next/server";
import { getKnowledgeState, addSource } from "@/infrastructure/context";
import { emit } from "@/infrastructure/events";
import { getBoard } from "@/infrastructure/boards";

export const dynamic = "force-dynamic";
// 取り込み時に LLM でドメイン知識を抽出するため余裕を持たせる
export const maxDuration = 300;

interface Params {
  params: { boardId: string };
}

// 知識ベースの全体像(ボード + 共通のソース一覧、カテゴリ別エントリ数)
export async function GET(_request: Request, { params }: Params) {
  return NextResponse.json(await getKnowledgeState(params.boardId));
}

// ファイルのアップロード → ドメイン知識の抽出(multipart/form-data)。
// common フィールドが "1" なら業務横断の共通知識として登録する。
export async function POST(request: Request, { params }: Params) {
  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json(
      { error: "指定のボードが見つかりません" },
      { status: 404 },
    );
  }

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
  const common = form.get("common") === "1";

  try {
    let state = await getKnowledgeState(params.boardId);
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      state = await addSource(params.boardId, file.name, buffer, common);
    }
    // 共通知識は全ボードに影響するため "*" で通知する
    emit(common ? "*" : params.boardId, "contexts");
    return NextResponse.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
