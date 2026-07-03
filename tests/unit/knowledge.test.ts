// 知識ベース(ユースケース + 永続化 + skill レンダリング)の特性テスト。
// LLM 抽出はモックし、ファイル IO は一時ディレクトリ(DATA_DIR)へ隔離する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LLM 抽出をモック(agent モジュールごと差し替え。ゲートウェイの他機能は使わない)
const extractMock = vi.fn();
vi.mock("@/infrastructure/agent", () => ({
  extractKnowledge: (...args: unknown[]) => extractMock(...args),
}));

import {
  addSource,
  deleteSource,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceMarkdown,
  prepareSkillsForChat,
  reextractSource,
  setSourceEnabled,
} from "@/infrastructure/context";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-kb-"));
  process.env.DATA_DIR = tmp;
  extractMock.mockReset();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const BOARD = "board-test";

const entriesA = [
  { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認" },
  { category: "terms", title: "送金指示番号", content: "英数字12桁" },
];

describe("知識ベース", () => {
  it("addSource: 原ファイル保存 + 抽出エントリ + カテゴリ skill を生成する", async () => {
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("メモ本文"));

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].entryCount).toBe(2);
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(1);

    // 原ファイルが保存されている
    const srcDir = path.join(tmp, "workspaces", BOARD, "sources", state.sources[0].id);
    await expect(fs.readFile(path.join(srcDir, "memo.txt"), "utf-8")).resolves.toBe("メモ本文");

    // skill がレンダリングされ、description にタイトルが入る
    const skill = await fs.readFile(
      path.join(tmp, "workspaces", BOARD, ".claude", "skills", "kb-flows", "SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain("name: kb-flows");
    expect(skill).toContain("承認ルール");
    expect(skill).toContain("_出典: memo.txt_");
  });

  it("setSourceEnabled(false) で skill が消え、戻すと再生される", async () => {
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("x"));
    const id = state.sources[0].id;
    const skillPath = path.join(tmp, "workspaces", BOARD, ".claude", "skills", "kb-flows", "SKILL.md");

    await setSourceEnabled(BOARD, id, false);
    await expect(fs.access(skillPath)).rejects.toThrow();
    expect(await prepareSkillsForChat(BOARD)).toEqual([]);

    await setSourceEnabled(BOARD, id, true);
    await expect(fs.access(skillPath)).resolves.toBeUndefined();
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-flows", "kb-terms"]),
    );
  });

  it("共通知識は kb-common-* になり、チャット準備で他ボードへ同期される", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "BSAD", content: "基本設計書の略称" },
    ]);
    await addSource(BOARD, "用語集.xlsx" + ".txt", Buffer.from("x"), true);

    // 別ボードからも見え、skill 名は kb-common-terms
    const other = "board-other";
    const state = await getKnowledgeState(other);
    expect(state.sources[0].scope).toBe("common");
    const skills = await prepareSkillsForChat(other);
    expect(skills).toEqual(["kb-common-terms"]);

    // 同期コピーされたファイルが存在する
    const synced = path.join(tmp, "workspaces", other, ".claude", "skills", "kb-common-terms", "SKILL.md");
    await expect(fs.access(synced)).resolves.toBeUndefined();
  });

  it("deleteSource でエントリ・skill・原ファイルが消える", async () => {
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("x"));
    const next = await deleteSource(BOARD, state.sources[0].id);
    expect(next.sources).toHaveLength(0);
    expect(next.categories.every((c) => c.count === 0)).toBe(true);
    const skillPath = path.join(tmp, "workspaces", BOARD, ".claude", "skills", "kb-flows");
    await expect(fs.access(skillPath)).rejects.toThrow();
  });

  it("reextractSource は原ファイルから再抽出してエントリを差し替える", async () => {
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("原文"));
    const id = state.sources[0].id;

    extractMock.mockResolvedValue([
      { category: "background", title: "課題", content: "月末に滞留する" },
    ]);
    const next = await reextractSource(BOARD, id);
    expect(next.sources[0].entryCount).toBe(1);
    expect(next.categories.find((c) => c.category === "background")?.count).toBe(1);
    expect(next.categories.find((c) => c.category === "flows")?.count).toBe(0);
    // 再抽出には原ファイルの内容が渡る
    expect(extractMock).toHaveBeenLastCalledWith("memo.txt", expect.stringContaining("原文"));
  });

  it("カテゴリ閲覧はボード + 共通をマージし、共通には(共通)が付く", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "ボード用語", content: "b" },
    ]);
    await addSource(BOARD, "board.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "terms", title: "共通用語", content: "c" },
    ]);
    await addSource(BOARD, "common.txt", Buffer.from("x"), true);

    const { markdown } = await getCategoryMarkdown(BOARD, "terms");
    expect(markdown).toContain("ボード用語");
    expect(markdown).toContain("共通用語");
    expect(markdown).toContain("_出典: common.txt(共通)_");
  });

  it("ソース閲覧は出典確認用の Markdown を返す", async () => {
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("x"));
    const { meta, markdown } = await getSourceMarkdown(BOARD, state.sources[0].id);
    expect(meta.fileName).toBe("memo.txt");
    expect(markdown).toContain("## 承認ルール");
  });

  it("未対応の拡張子・空の抽出はエラーにする", async () => {
    await expect(addSource(BOARD, "x.docx", Buffer.from("x"))).rejects.toThrow("未対応");
    extractMock.mockResolvedValue([]);
    await expect(addSource(BOARD, "empty.txt", Buffer.from("x"))).rejects.toThrow("抽出できません");
  });
});

describe("共通ビューと業務⇄共通の移動", () => {
  it("getKnowledgeState(null) は共通のみを返す(管理画面ビュー)", async () => {
    extractMock.mockResolvedValue(entriesA);
    await addSource(BOARD, "board.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "terms", title: "共通用語", content: "c" },
    ]);
    await addSource(null, "common.txt", Buffer.from("x"));

    const { getKnowledgeState } = await import("@/infrastructure/context");
    const state = await getKnowledgeState(null);
    expect(state.sources.map((s) => s.fileName)).toEqual(["common.txt"]);
    expect(state.sources[0].scope).toBe("common");
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(0);
    expect(state.categories.find((c) => c.category === "terms")?.count).toBe(1);
  });

  it("moveSource: 業務 → 共通(エントリ・原資料ごと移り、両側の skill が更新される)", async () => {
    const { moveSource, prepareSkillsForChat: prep } = await import(
      "@/infrastructure/context"
    );
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("原文"));
    const id = state.sources[0].id;

    const moved = await moveSource(BOARD, id, true);
    expect(moved.sources[0].scope).toBe("common");

    // 業務側の skill は消え、チャット準備では kb-common-* として提示される
    const skills = await prep(BOARD);
    expect(skills).toEqual(
      expect.arrayContaining(["kb-common-flows", "kb-common-terms"]),
    );
    expect(skills).not.toContain("kb-flows");

    // 別ボードからも見える(共通になった)
    const other = await prep("board-other");
    expect(other).toContain("kb-common-flows");

    // 原資料も移っている → 再抽出が共通側で動く
    extractMock.mockResolvedValue([
      { category: "flows", title: "改訂ルール", content: "改訂済み" },
    ]);
    const re = await reextractSource(BOARD, id);
    expect(re.sources[0].entryCount).toBe(1);
    expect(extractMock).toHaveBeenLastCalledWith("memo.txt", expect.stringContaining("原文"));
  });

  it("moveSource: 共通 → この業務(他ボードからは見えなくなる)", async () => {
    const { moveSource, prepareSkillsForChat: prep } = await import(
      "@/infrastructure/context"
    );
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(null, "共通.txt", Buffer.from("x"));
    const id = state.sources[0].id;

    const moved = await moveSource(BOARD, id, false);
    expect(moved.sources[0].scope).toBe("board");
    expect(await prep(BOARD)).toEqual(
      expect.arrayContaining(["kb-flows", "kb-terms"]),
    );
    expect(await prep("board-other")).toEqual([]);
  });
  it("moveSource: 原資料ディレクトリが無くても移動できる(旧データ耐性)", async () => {
    const { moveSource } = await import("@/infrastructure/context");
    // 原資料なしで直接シード(旧形式相当)
    const { writeJson, sourcesFile, knowledgeFile } = await import(
      "@/infrastructure/context/repository"
    );
    await writeJson(sourcesFile(BOARD), [
      { id: "legacy", fileName: "old.txt", scope: "board", enabled: true, entryCount: 1, uploadedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await writeJson(knowledgeFile(BOARD), [
      { id: "le", sourceId: "legacy", category: "flows", title: "旧", content: "x" },
    ]);
    const moved = await moveSource(BOARD, "legacy", true);
    expect(moved.sources.find((s) => s.id === "legacy")?.scope).toBe("common");
  });
});