import { NextResponse } from "next/server";
import { loadStoryMap, saveStoryMap } from "@/infrastructure/storage";
import { emit } from "@/infrastructure/events";
import { normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";

export const dynamic = "force-dynamic";

// 現在のストーリーマップを取得
export async function GET() {
  const map = await loadStoryMap();
  return NextResponse.json(map);
}

// ボード上での編集(ドラッグ&ドロップ・追加・削除)を保存
export async function PUT(request: Request) {
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
  await saveStoryMap(normalized, "edit", "ボードを編集");
  // 他のメンバーの画面へ反映を促す(薄い通知 → クライアントが再取得)
  emit("storymap");
  return NextResponse.json(normalized);
}
