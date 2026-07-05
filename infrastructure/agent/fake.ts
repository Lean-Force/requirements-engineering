// LLM 境界の決定的フェイク(USM_FAKE_LLM=1 で有効)。
//
// テスト戦略(TESTING.md)の中核: モックしてよいのは LLM 境界だけで、
// それも vi.mock ではなくこの「プロダクトが公式に持つテストモード」で差し替える。
// これにより API ルート → ユースケース → ドメイン → 永続化 → skill 描画の
// 全配線を、本物のコードのまま決定的にテストできる(統合テスト・E2E 用)。
// 本物の LLM の挙動は tests/eval が同じ関数契約で検証する。
//
// 入力に埋め込むディレクティブ(1 行 1 つ):
//   FAKEMAP:{...json...}        generate: 返す storyMap(無ければ現在のマップをそのまま返す)
//   FAKEREPLY:テキスト           generate: 返信文
//   KB|category|title|content|common      抽出: knowledge エントリ 1 件
//   NOKB                        抽出: 空(「抽出できない」経路の検証用)
//   CONFLICTS_JSON:[{...}]      矛盾検出: 検出結果の配列(エントリ content に埋め込める)
//   PROPOSE_BOARD_JSON:{...}    新業務検知: {name, reason}(エントリ content に埋め込める)
//   FAKESUGGEST:テキスト         付箋校正: 提案本文
//   REVISE|title|content|common エントリ修正: 修正後の値

import type { RefineRequest, RefineResponse } from "@/contracts";
import type { StoryMap } from "@/domain";
import type { ChatMessage, EntryRevision, KnowledgeCategory } from "@/contracts";
import type { DetectedBusiness, DetectedConflict, ExtractedEntry } from "./types";

export const isFakeLlm = (): boolean => process.env.USM_FAKE_LLM === "1";

const line = (text: string, prefix: string): string | undefined =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(prefix))
    ?.slice(prefix.length);

export function fakeGenerate(
  conversation: ChatMessage[],
  boardContext: string,
): { reply: string; storyMap: StoryMap } {
  const text = conversation.map((m) => m.content).join("\n");
  const mapJson = line(text, "FAKEMAP:");
  // ディレクティブが無ければ、標準ブロック内の「現在のマップ」をそのまま返す(無変更ターン)
  const current = /# 現在の User Story Map[^\n]*\n\n(\{.*\})/.exec(boardContext)?.[1];
  const storyMap: StoryMap = mapJson
    ? (JSON.parse(mapJson) as StoryMap)
    : current
      ? (JSON.parse(current) as StoryMap)
      : { actors: [], activities: [] };
  return {
    reply: line(text, "FAKEREPLY:") ?? "(fake) マップを更新しました",
    storyMap,
  };
}

export function fakeExtract(markdown: string): ExtractedEntry[] {
  if (markdown.includes("NOKB")) return [];
  const entries: ExtractedEntry[] = [];
  for (const l of markdown.split("\n")) {
    const m = l.trim();
    if (!m.startsWith("KB|")) continue;
    const [, category, title, content, common] = m.split("|");
    entries.push({
      category: category as KnowledgeCategory,
      title,
      content,
      common: common === "true",
    });
  }
  if (entries.length > 0) return entries;
  // ディレクティブなしの資料も取り込めるように、先頭行から 1 エントリ作る
  const first = markdown.split("\n").find((l) => l.trim()) ?? "内容";
  return [
    { category: "flows", title: "自動抽出(fake)", content: first.trim(), common: false },
  ];
}

export function fakeDetectConflicts(newEntriesText: string): DetectedConflict[] {
  const conflicts: DetectedConflict[] = [];
  for (const l of newEntriesText.split("\n")) {
    const i = l.indexOf("CONFLICTS_JSON:");
    if (i < 0) continue;
    conflicts.push(...(JSON.parse(l.slice(i + "CONFLICTS_JSON:".length)) as DetectedConflict[]));
  }
  return conflicts;
}

export function fakeRefine(req: RefineRequest): RefineResponse {
  return {
    suggestion: line(req.text, "FAKESUGGEST:") ?? `${req.text.trim()}(校正済み・fake)`,
    note: "(fake) 推敲しました",
  };
}

export function fakeReviseEntry(
  current: { title: string; content: string; common: boolean },
  instruction: string,
): EntryRevision {
  const directive = line(instruction, "REVISE|");
  if (directive) {
    const [title, content, common] = directive.split("|");
    return { title, content, common: common === "true", note: "(fake) 指示どおり修正" };
  }
  return {
    title: current.title,
    content: `${current.content}(修正済み・fake)`,
    common: current.common,
    note: "(fake) 修正しました",
  };
}

export function fakeDetectNewBusiness(entriesText: string): DetectedBusiness {
  for (const l of entriesText.split("\n")) {
    const i = l.indexOf("PROPOSE_BOARD_JSON:");
    if (i < 0) continue;
    const { name, reason } = JSON.parse(l.slice(i + "PROPOSE_BOARD_JSON:".length)) as {
      name: string;
      reason: string;
    };
    return { isNewBusiness: true, name, reason };
  }
  return { isNewBusiness: false, name: "", reason: "(fake) 既存業務の範囲" };
}
