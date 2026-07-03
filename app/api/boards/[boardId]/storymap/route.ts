import { NextResponse } from "next/server";
import { loadStoryMap, saveStoryMap } from "@/infrastructure/storage";
import { emit } from "@/infrastructure/events";
import { getBoard } from "@/infrastructure/boards";
import { normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";

export const dynamic = "force-dynamic";

interface Params {
  params: { boardId: string };
}

// 現在のストーリーマップを取得
export async function GET(_request: Request, { params }: Params) {
  const map = await loadStoryMap(params.boardId);
  return NextResponse.json(map);
}

// ボード上での編集(ドラッグ&ドロップ・追加・削除)を保存
export async function PUT(request: Request, { params }: Params) {
  try {
    await getBoard(params.boardId);
  } catch {
    return NextResponse.json(
      { error: "指定のボードが見つかりません" },
      { status: 404 },
    );
  }

  let map: StoryMap;
  try {
    map = (await request.json()) as StoryMap;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  if (!map || !Array.isArray(map.actors) || !Array.isArray(map.activities)) {
    return NextResponse.json(
      { error: "ストーリーマップの形式が不正です" },
      { status: 400 },
    );
  }

  const normalized = normalizeStoryMap(map);
  // 連続するボード編集は版履歴上で 1 つに畳み込まれる(storage 側の方針)
  await saveStoryMap(params.boardId, normalized, "edit", "ボードを編集");
  // 同じボードを見ている他メンバーの画面へ反映を促す
  emit(params.boardId, "storymap");
  return NextResponse.json(normalized);
}
