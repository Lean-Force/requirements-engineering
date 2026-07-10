// 会話履歴の圧縮(rolling compaction)の決定的テスト(LLM 不要)。
// 要約そのものの品質は L4 eval(実 LLM)が担い、ここでは
// 「いつ要約するか」「要約 + 直近原文の分割」「クリア・巻き戻しへの耐性」を保証する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "@/contracts";
import {
  clearChatSummary,
  compactionPlan,
  loadChatSummary,
  prepareConversation,
} from "@/infrastructure/conversation";
import { workspaceDir } from "@/infrastructure/context";

let tmp: string;
const BOARD = "conv-board";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-conv-"));
  process.env.DATA_DIR = tmp;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const msgs = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `発話${i}`,
  }));

/** 要約ファイルを直接置く(LLM を呼ばずに「要約済み」状態を作る) */
async function seedSummary(text: string, covered: number): Promise<void> {
  await fs.mkdir(workspaceDir(BOARD), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir(BOARD), "chat-summary.json"),
    JSON.stringify({ text, covered }),
    "utf-8",
  );
}

describe("compactionPlan(いつ要約するか)", () => {
  it("会話が短いうちは要約しない", () => {
    expect(compactionPlan(10, 0, 20, 10).summarizeUpTo).toBeNull();
    expect(compactionPlan(29, 0, 20, 10).summarizeUpTo).toBeNull();
  });

  it("直近を除いた未カバー分が batch 件溜まったら、そこまで要約する", () => {
    expect(compactionPlan(30, 0, 20, 10).summarizeUpTo).toBe(10);
    expect(compactionPlan(46, 0, 20, 10).summarizeUpTo).toBe(26);
  });

  it("要約済みの分はカウントしない(毎ターンは要約しない)", () => {
    // covered=10 のあと 2 ターン(4 件)進んだだけでは再要約しない
    expect(compactionPlan(34, 10, 20, 10).summarizeUpTo).toBeNull();
    // batch 件たまったら差分だけ再要約
    expect(compactionPlan(40, 10, 20, 10).summarizeUpTo).toBe(20);
  });
});

describe("prepareConversation(要約 + 直近原文への整理)", () => {
  it("要約が無く閾値未満なら、原文をそのまま返し LLM を呼ばない", async () => {
    const conversation = msgs(10);
    const { summary, recent } = await prepareConversation(BOARD, conversation);
    expect(summary).toBeUndefined();
    expect(recent).toEqual(conversation);
    expect(await loadChatSummary(BOARD)).toBeNull();
  });

  it("要約済みなら「要約 + カバー後の原文」に分割する(再要約はしない)", async () => {
    await seedSummary("- 承認者は佐藤部長(規程のため)", 10);
    const conversation = msgs(32); // 未カバー 32-20=12... batch=10 だが covered=10 → 差分2
    const { summary, recent } = await prepareConversation(BOARD, conversation);
    expect(summary).toContain("佐藤部長");
    expect(recent).toEqual(conversation.slice(10));
  });

  it("会話がクリア・巻き戻しされたら古い要約を捨てる", async () => {
    await seedSummary("- 古い決定", 30);
    const conversation = msgs(4); // covered(30) > 現在長(4)
    const { summary, recent } = await prepareConversation(BOARD, conversation);
    expect(summary).toBeUndefined();
    expect(recent).toEqual(conversation);
    expect(await loadChatSummary(BOARD)).toBeNull(); // リセットが永続化される
  });

  // 注: 「要約の失敗時に原文で続行する」フォールバックは LLM を跨ぐため
  // ユニットでは検証しない(prepareConversation の try/catch)。品質は L4 が担う。

  it("clearChatSummary で要約が消える", async () => {
    await seedSummary("- 何かの決定", 10);
    await clearChatSummary(BOARD);
    expect(await loadChatSummary(BOARD)).toBeNull();
  });
});
