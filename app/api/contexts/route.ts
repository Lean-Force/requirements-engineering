import { NextResponse } from "next/server";
import {
  listContexts,
  addContextsFromFile,
} from "@/infrastructure/context/store";
import { emit } from "@/infrastructure/events";

export const dynamic = "force-dynamic";

// コンテキスト(参照資料)の一覧
export async function GET() {
  return NextResponse.json(await listContexts());
}

// ファイルのアップロード(multipart/form-data、files フィールドに複数可)
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
    let docs = await listContexts();
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      docs = await addContextsFromFile(file.name, buffer);
    }
    emit("contexts");
    return NextResponse.json(docs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
