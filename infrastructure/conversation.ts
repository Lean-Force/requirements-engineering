// インフラ層: 会話履歴の圧縮(rolling compaction)。
//
// チャットの会話を LLM へそのまま送り続けるとプロンプトが会話量に比例して
// 肥大するため、「古い経緯は要約、直近だけ原文」に整理する:
//   - 直近 CHAT_VERBATIM_MESSAGES 件(既定 20)は原文のまま渡す
//   - それより古い発話は、決定事項・理由・指示・未解決点を保持した要約に畳む
//   - 要約は workspaces/<boardId>/chat-summary.json に永続化し、
//     未要約の古い発話が CHAT_COMPACT_BATCH 件(既定 10)溜まったときだけ
//     更新する(毎ターンは呼ばない。約 5 ターンに 1 回の追加 LLM 呼び出し)
//   - 要約に失敗してもチャットは止めない(原文のまま続行するフォールバック)
//
// 決定と理由(rationale)を要約が保持することは SUMMARIZE_SYSTEM_PROMPT が担う。

import { promises as fs } from "fs";
import path from "path";
import type { ChatMessage } from "@/contracts";
import { summarizeHistory } from "./agent";
import { workspaceDir } from "./context/workspace";

export interface ChatSummary {
  /** これまでの経緯の要約(Markdown) */
  text: string;
  /** messages の先頭から何件分をこの要約がカバーしているか */
  covered: number;
}

const summaryFile = (boardId: string) =>
  path.join(workspaceDir(boardId), "chat-summary.json");

export async function loadChatSummary(
  boardId: string,
): Promise<ChatSummary | null> {
  try {
    const s = JSON.parse(
      await fs.readFile(summaryFile(boardId), "utf-8"),
    ) as ChatSummary;
    return typeof s.text === "string" && typeof s.covered === "number" ? s : null;
  } catch {
    return null;
  }
}

async function saveChatSummary(boardId: string, s: ChatSummary): Promise<void> {
  await fs.mkdir(workspaceDir(boardId), { recursive: true });
  await fs.writeFile(summaryFile(boardId), JSON.stringify(s, null, 2), "utf-8");
}

/** 会話クリア時に呼ぶ(要約も一緒に消す) */
export async function clearChatSummary(boardId: string): Promise<void> {
  await fs.rm(summaryFile(boardId), { force: true });
}

/**
 * 圧縮の判断(純粋関数。テストの対象)。
 * 「直近 verbatim 件を残した残り」がまだ要約にカバーされておらず、
 * 未カバー分が batch 件以上溜まっていたら、そこまで(summarizeUpTo)を要約する。
 */
export function compactionPlan(
  total: number,
  covered: number,
  verbatim = Number(process.env.CHAT_VERBATIM_MESSAGES || 20),
  batch = Number(process.env.CHAT_COMPACT_BATCH || 10),
): { summarizeUpTo: number | null } {
  const target = total - verbatim;
  if (target > 0 && target - covered >= batch) return { summarizeUpTo: target };
  return { summarizeUpTo: null };
}

/**
 * 会話を「要約 + 直近原文」に整理する(チャットターンの入口で呼ぶ。
 * ボードのチャットロック内で呼ばれる前提なので同時実行は考えない)。
 * 会話がクリア・巻き戻しされた場合(covered が現在長を超える)は要約を捨てる。
 */
export async function prepareConversation(
  boardId: string,
  messages: ChatMessage[],
): Promise<{ summary?: string; recent: ChatMessage[] }> {
  let s = await loadChatSummary(boardId);
  if (s && s.covered > messages.length) {
    await clearChatSummary(boardId);
    s = null;
  }

  const plan = compactionPlan(messages.length, s?.covered ?? 0);
  if (plan.summarizeUpTo !== null) {
    try {
      const text = await summarizeHistory(
        s?.text,
        messages.slice(s?.covered ?? 0, plan.summarizeUpTo),
      );
      s = { text, covered: plan.summarizeUpTo };
      await saveChatSummary(boardId, s);
    } catch (err) {
      // 要約の失敗でチャットを止めない(このターンは原文のまま続行)
      console.warn(`会話の要約に失敗(原文で続行): ${String(err)}`);
    }
  }

  if (!s) return { recent: messages };
  return { summary: s.text, recent: messages.slice(s.covered) };
}
