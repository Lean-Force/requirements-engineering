import { NextResponse } from "next/server";
import { isConfigured, generate } from "@/infrastructure/agent";
import { loadStoryMap, applyChatTurn } from "@/infrastructure/storage";
import {
  addChatKnowledge,
  buildBoardContext,
  deleteEntry,
  deleteSource,
  getKnowledgeState,
  listOwnEntries,
  reextractSource,
  setSourceEnabled,
  updateEntry,
} from "@/infrastructure/context";
import type { KnowledgeToolHandlers } from "@/infrastructure/agent/knowledge-tools";
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

  // 入力の妥当性を先に返し、接続設定の問題は最後に 500 で返す
  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          "LLM が未設定です。CLAUDE_CODE_USE_BEDROCK=1(+ AWS 認証)または ANTHROPIC_API_KEY を設定してサーバーを再起動してください。",
      },
      { status: 500 },
    );
  }


  // 同じボードを共有するメンバーの AI ターンは到着順に直列処理する
  return withChatLock(boardId, async () => {
    emit(boardId, "chat:start");
    try {
      // ミューテックス通過後に読み直す(直前のターンの結果を正とする)
      const currentMap = await loadStoryMap(boardId);

      // 標準コンテキストブロック(業務一覧 + 知識 + 共通 + 確定マップ + 現在のマップ)を
      // system prompt へ注入する(会話メッセージはユーザーの発話のまま手を加えない)
      const boardContext = await buildBoardContext(boardId, currentMap);

      // 知識ツールのハンドラ(context のユースケースを結線)。
      // 知識が変更されたら、ターン終了後に全ボードへ contexts を通知する
      let knowledgeMutated = false;
      const knowledgeHandlers: KnowledgeToolHandlers = {
        list: async () =>
          (await listOwnEntries(boardId)).map(
            ({ sourceId: _s, content: _c, ...e }) => e,
          ),
        update: async (entryId, patch) => {
          const entry = (await listOwnEntries(boardId)).find((e) => e.id === entryId);
          if (!entry) return `id ${entryId} のエントリは見つかりません(list で確認してください)`;
          await updateEntry(boardId, entry.sourceId, entryId, {
            title: patch.title ?? entry.title,
            content: patch.content ?? entry.content,
            common: patch.common ?? entry.common,
          });
          knowledgeMutated = true;
          return `エントリ「${patch.title ?? entry.title}」を修正しました(修正済み扱い)`;
        },
        remove: async (entryId) => {
          const entry = (await listOwnEntries(boardId)).find((e) => e.id === entryId);
          if (!entry) return `id ${entryId} のエントリは見つかりません`;
          await deleteEntry(boardId, entry.sourceId, entryId);
          knowledgeMutated = true;
          return `エントリ「${entry.title}」を削除しました`;
        },
        add: async (entry) => {
          const added = await addChatKnowledge(boardId, entry);
          knowledgeMutated = true;
          return `知識「${added.title}」を追加しました(出典: チャットでの決定${added.common ? "・共通" : ""})`;
        },
        listSources: async () =>
          (await getKnowledgeState(boardId)).sources.map((s) => ({
            id: s.id,
            fileName: s.fileName,
            enabled: s.enabled,
            entryCount: s.entryCount,
          })),
        setSourceEnabled: async (sourceId, enabled) => {
          const state = await setSourceEnabled(boardId, sourceId, enabled);
          knowledgeMutated = true;
          const name = state.sources.find((s) => s.id === sourceId)?.fileName ?? sourceId;
          return `資料「${name}」を${enabled ? "有効" : "無効"}にしました(AI への提示が変わります)`;
        },
        removeSource: async (sourceId) => {
          const name =
            (await getKnowledgeState(boardId)).sources.find((s) => s.id === sourceId)
              ?.fileName ?? sourceId;
          await deleteSource(boardId, sourceId);
          knowledgeMutated = true;
          return `資料「${name}」を削除しました(抽出済みの知識も消えました)`;
        },
        reextractSource: async (sourceId) => {
          const state = await reextractSource(boardId, sourceId);
          knowledgeMutated = true;
          const source = state.sources.find((s) => s.id === sourceId);
          return `資料「${source?.fileName ?? sourceId}」を再抽出しました(${source?.entryCount ?? "?"} 件)`;
        },
      };

      const parsed = await generate(boardId, messages, boardContext, knowledgeHandlers);

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

      if (knowledgeMutated) emit("*", "contexts");

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
