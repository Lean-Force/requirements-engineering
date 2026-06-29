import { NextResponse } from "next/server";
import { isConfigured, generate } from "@/infrastructure/litellm";
import { loadStoryMap, applyChatTurn } from "@/infrastructure/storage";
import { normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type { ChatMessage, ChatResponse } from "@/contracts";

export const dynamic = "force-dynamic";
// 応答に時間がかかることがあるため余裕を持たせる
export const maxDuration = 120;

interface ChatRequestBody {
  messages: ChatMessage[];
  storyMap: StoryMap;
}

export async function POST(request: Request) {
  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          "LITELLM_API_KEY が未設定です。.env.local に設定してサーバーを再起動してください。",
      },
      { status: 500 },
    );
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  const { messages } = body;
  // 念のためサーバー側の保存済みマップを正とする
  const currentMap = body.storyMap ?? (await loadStoryMap());

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages が空です" }, { status: 400 });
  }

  // 最後のユーザーメッセージに現在のマップ(JSON)を文脈として付与する
  const conversation: ChatMessage[] = messages.map((m) => ({ ...m }));
  const last = conversation[conversation.length - 1];
  conversation[conversation.length - 1] = {
    role: last.role,
    content: `${last.content}

---
現在の User Story Map(この内容をベースに更新してください):
${JSON.stringify(currentMap)}`,
  };

  try {
    const parsed = await generate(conversation);

    // アクター/actorId のゆれを正規化
    const updatedMap = normalizeStoryMap(parsed.storyMap);

    // この 1 ターンを永続化(マップ更新 + 版追加 + 会話保存)。
    // 会話は「受け取った messages(末尾が今回のユーザー発言)+ 今回の AI 返信」を保存する。
    const fullConversation: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: parsed.reply },
    ];
    const { storyMap, versions } = await applyChatTurn(
      updatedMap,
      parsed.reply,
      fullConversation,
    );

    const result: ChatResponse = { reply: parsed.reply, storyMap, versions };
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `LLM 呼び出しに失敗しました: ${message}` },
      { status: 502 },
    );
  }
}
