import { NextResponse } from "next/server";
import { generatePbi, isConfigured } from "@/infrastructure/agent";
import { classifyEars, EARS_PATTERN_LABELS } from "@/infrastructure/agent/ears";
import type { EarsPattern } from "@/infrastructure/agent/ears";
import { buildChatContext, syncKnowledgeSkills } from "@/infrastructure/context";
import { getBoard } from "@/infrastructure/boards";
import { loadStoryMap } from "@/infrastructure/storage";

export const dynamic = "force-dynamic";
// 知識(kb-* skill)の読み込みを含むエージェントループのため時間がかかることがある
export const maxDuration = 300;

interface Params {
  params: { boardId: string };
}

// ストーリー 1 枚を PBI(EARS 記法の要求つき)へ変換する
export async function POST(request: Request, { params }: Params) {
  const { boardId } = params;
  try {
    await getBoard(boardId);
  } catch {
    return NextResponse.json({ error: "指定のボードが見つかりません" }, { status: 404 });
  }

  let body: { storyId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (typeof body.storyId !== "string" || body.storyId === "") {
    return NextResponse.json({ error: "storyId が必要です" }, { status: 400 });
  }

  if (!isConfigured()) {
    return NextResponse.json(
      { error: "LLM が未設定です。サーバーの環境変数を確認してください。" },
      { status: 500 },
    );
  }

  // ストーリーと文脈(タスク・ステップ・アクティビティ)をマップから引く
  const map = await loadStoryMap(boardId);
  let found:
    | {
        storyText: string;
        actorName?: string;
        actionText: string;
        sceneActions: string[];
        flowName?: string;
      }
    | null = null;
  for (const activity of map.activities) {
    for (const action of activity.actions) {
      const story = action.stories.find((s) => s.id === body.storyId);
      if (!story) continue;
      found = {
        storyText: story.text,
        actorName: map.actors.find((a) => a.id === action.actorId)?.name,
        actionText: action.text,
        sceneActions: activity.actions.map((a) => a.text),
        flowName: activity.flowName,
      };
    }
  }
  if (!found) {
    return NextResponse.json({ error: "指定のストーリーが見つかりません" }, { status: 404 });
  }

  try {
    await syncKnowledgeSkills(boardId);
    const chatContext = await buildChatContext(boardId, map);
    const pbi = await generatePbi(boardId, found, chatContext);

    // EARS 形式の検証(形式外の行はパターンを「形式外」として UI に示す)
    const requirements = pbi.requirements.map((r) => {
      const actual = classifyEars(r.text);
      return {
        ...r,
        patternLabel: actual
          ? EARS_PATTERN_LABELS[actual]
          : "形式外",
        conforms: actual !== null,
        pattern: (actual ?? r.pattern) as EarsPattern,
      };
    });
    return NextResponse.json({ ...pbi, requirements });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `PBI の生成に失敗しました: ${message}` },
      { status: 502 },
    );
  }
}
