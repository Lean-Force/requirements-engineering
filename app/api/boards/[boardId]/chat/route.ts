import { NextResponse } from "next/server";
import { isConfigured, generate } from "@/infrastructure/agent";
import { loadStoryMap, applyChatTurn } from "@/infrastructure/storage";
import { buildKnowledgeContext } from "@/infrastructure/context";
import { withChatLock } from "@/infrastructure/chat-lock";
import { emit } from "@/infrastructure/events";
import { getBoard } from "@/infrastructure/boards";
import { applyAiUpdate } from "@/domain";
import type { StoryMap } from "@/domain";
import type { ChatMessage, ChatResponse } from "@/contracts";

export const dynamic = "force-dynamic";
// エージェントループ(ドメイン知識の読み込みを含む)に時間がかかることがある
export const maxDuration = 300;

interface ChatRequestBody {
  messages: ChatMessage[];
  storyMap: StoryMap;
}

interface Params {
  params: { boardId: string };
}

export async function POST(request: Request, { params }: Params) {
  const { boardId } = params;

  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          "LLM が未設定です。CLAUDE_CODE_USE_BEDROCK=1(+ AWS 認証)または ANTHROPIC_API_KEY を設定してサーバーを再起動してください。",
      },
      { status: 500 },
    );
  }

  try {
    await getBoard(boardId);
  } catch {
    return NextResponse.json(
      { error: "指定のボードが見つかりません" },
      { status: 404 },
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

  // 同じボードを共有するメンバーの AI ターンは到着順に直列処理する
  return withChatLock(boardId, async () => {
    emit(boardId, "chat:start");
    try {
      // ミューテックス通過後に読み直す(直前のターンの結果を正とする)
      const currentMap = await loadStoryMap(boardId);

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

      // このボードの知識 + 共通知識 + 各業務の確定マップを system prompt へ全文注入する
      const knowledgeContext = await buildKnowledgeContext(boardId);
      const parsed = await generate(boardId, conversation, knowledgeContext);

      // AI 出力を保存してよい形へ整える(正規化・確定要素の保護・表示順の引き継ぎ)。
      // 手順の順序は domain.applyAiUpdate に閉じている。
      const updatedMap = applyAiUpdate(currentMap, parsed.storyMap);

      // この 1 ターンを永続化(マップ更新 + 版追加 + 会話保存)。
      const fullConversation: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: parsed.reply },
      ];
      const { storyMap, versions } = await applyChatTurn(
        boardId,
        updatedMap,
        parsed.reply,
        fullConversation,
      );

      const result: ChatResponse = {
        reply: parsed.reply,
        storyMap,
        versions,
      };
      return NextResponse.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `LLM 呼び出しに失敗しました: ${message}` },
        { status: 502 },
      );
    } finally {
      // 成否に関わらず終了を通知(他クライアントはこれを機に再取得する)
      emit(boardId, "chat:end");
    }
  });
}
