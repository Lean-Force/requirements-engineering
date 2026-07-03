import { NextResponse } from "next/server";
import { isConfigured, generate } from "@/infrastructure/agent";
import { loadStoryMap, applyChatTurn } from "@/infrastructure/storage";
import { enabledSkillNames } from "@/infrastructure/context/store";
import { withChatLock } from "@/infrastructure/chat-lock";
import { emit } from "@/infrastructure/events";
import { normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type { ChatMessage, ChatResponse } from "@/contracts";

export const dynamic = "force-dynamic";
// エージェントループ(参照資料の読み込みを含む)に時間がかかることがある
export const maxDuration = 300;

interface ChatRequestBody {
  messages: ChatMessage[];
  storyMap: StoryMap;
}

export async function POST(request: Request) {
  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          "LLM が未設定です。CLAUDE_CODE_USE_BEDROCK=1(+ AWS 認証)または ANTHROPIC_API_KEY を設定してサーバーを再起動してください。",
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

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages が空です" }, { status: 400 });
  }

  // 共有ボードのため AI ターンは到着順に直列処理する
  return withChatLock(async () => {
    emit("chat:start");
    try {
      // ミューテックス通過後に読み直す(直前のターンの結果を正とする)
      const currentMap = await loadStoryMap();

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

      const skills = await enabledSkillNames();
      const parsed = await generate(conversation, skills);

      // アクター/actorId のゆれを正規化
      const updatedMap = normalizeStoryMap(parsed.storyMap);

      // この 1 ターンを永続化(マップ更新 + 版追加 + 会話保存)。
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
    } finally {
      // 成否に関わらず終了を通知(他クライアントはこれを機に再取得する)
      emit("chat:end");
    }
  });
}
