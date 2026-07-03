// 知識ベース(ユースケース + 永続化 + skill レンダリング)の特性テスト。
// LLM 抽出はモックし、ファイル IO は一時ディレクトリ(DATA_DIR)へ隔離する。
//
// スコープはエントリ単位: 抽出時に AI が common(業務横断)を判定し、
// common エントリは全ボード合成の kb-common-* に、それ以外はボードの kb-* に入る。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LLM 抽出をモック(agent モジュールごと差し替え。ゲートウェイの他機能は使わない)
const extractMock = vi.fn();
const reviseMock = vi.fn();
vi.mock("@/infrastructure/agent", () => ({
  extractKnowledgeMulti: (...args: unknown[]) => extractMock(...args),
  reviseEntry: (...args: unknown[]) => reviseMock(...args),
}));

import { createBoard } from "@/infrastructure/boards";
import {
  addSource,
  deleteEntry,
  getSourceEntries,
  proposeEntryRevision,
  updateEntry,
  deleteSource,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceMarkdown,
  prepareSkillsForChat,
  reextractSource,
  renderCommonSkills,
  setSourceEnabled,
} from "@/infrastructure/context";

let tmp: string;
let BOARD: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-kb-"));
  process.env.DATA_DIR = tmp;
  extractMock.mockReset();
  // 共通知識は「登録済みボード + _common」から合成されるため、ボードとして登録する
  BOARD = (await createBoard("テスト業務")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const entriesA = [
  { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
  { category: "terms", title: "送金指示番号", content: "英数字12桁", common: false },
];

const skillPath = (scope: string, name: string) =>
  path.join(tmp, "workspaces", scope, ".claude", "skills", name, "SKILL.md");

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
    const skill = await fs.readFile(skillPath(BOARD, "kb-flows"), "utf-8");
    expect(skill).toContain("name: kb-flows");
    expect(skill).toContain("承認ルール");
    expect(skill).toContain("_出典: memo.txt_");
  });

  it("AI が common と判定したエントリは kb-common-* へ、それ以外は kb-* へ入る", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "承認ルール", content: "業務固有", common: false },
      { category: "terms", title: "BSAD", content: "基本設計書の略称", common: true },
    ]);
    await addSource(BOARD, "設計書.txt", Buffer.from("x"));

    // 業務固有 → ボードの kb-flows(kb-terms は作られない)
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).resolves.toBeUndefined();
    await expect(fs.access(skillPath(BOARD, "kb-terms"))).rejects.toThrow();

    // 共通 → _common の kb-common-terms に合成され、チャット準備で提示される
    const common = await fs.readFile(skillPath("_common", "kb-common-terms"), "utf-8");
    expect(common).toContain("BSAD");
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-flows", "kb-common-terms"]),
    );

    // 別ボードのチャット準備でも共通知識だけが同期される
    const other = (await createBoard("別業務")).id;
    expect(await prepareSkillsForChat(other)).toEqual(["kb-common-terms"]);
    await expect(fs.access(skillPath(other, "kb-common-terms"))).resolves.toBeUndefined();
  });

  it("setSourceEnabled(false) で業務固有・共通の両 skill から消え、戻すと再生される", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "承認ルール", content: "業務固有", common: false },
      { category: "terms", title: "BSAD", content: "略称", common: true },
    ]);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("x"));
    const id = state.sources[0].id;

    await setSourceEnabled(BOARD, id, false);
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).rejects.toThrow();
    await expect(fs.access(skillPath("_common", "kb-common-terms"))).rejects.toThrow();
    expect(await prepareSkillsForChat(BOARD)).toEqual([]);

    await setSourceEnabled(BOARD, id, true);
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-flows", "kb-common-terms"]),
    );
  });

  it("deleteSource でエントリ・skill・原ファイルが消える(共通へ振り分けた分も)", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "承認ルール", content: "業務固有", common: false },
      { category: "terms", title: "BSAD", content: "略称", common: true },
    ]);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("x"));
    const next = await deleteSource(BOARD, state.sources[0].id);
    expect(next.sources).toHaveLength(0);
    expect(next.categories.every((c) => c.count === 0)).toBe(true);
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).rejects.toThrow();
    await expect(fs.access(skillPath("_common", "kb-common-terms"))).rejects.toThrow();
  });

  it("reextractSource は原ファイルから再抽出してエントリを差し替える", async () => {
    extractMock.mockResolvedValue(entriesA);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("原文"));
    const id = state.sources[0].id;

    extractMock.mockResolvedValue([
      { category: "background", title: "課題", content: "月末に滞留する", common: false },
    ]);
    const next = await reextractSource(BOARD, id);
    expect(next.sources[0].entryCount).toBe(1);
    expect(next.categories.find((c) => c.category === "background")?.count).toBe(1);
    expect(next.categories.find((c) => c.category === "flows")?.count).toBe(0);
    // 再抽出には原ファイルの内容が渡る
    expect(extractMock).toHaveBeenLastCalledWith("memo.txt", expect.stringContaining("原文"));
  });

  it("カテゴリ閲覧はボード + 共通をマージし、他スコープ由来の共通には(共通)が付く", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "ボード用語", content: "b", common: false },
    ]);
    await addSource(BOARD, "board.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "terms", title: "共通用語", content: "c", common: true },
    ]);
    await addSource(null, "common.txt", Buffer.from("x"));

    const { markdown } = await getCategoryMarkdown(BOARD, "terms");
    expect(markdown).toContain("ボード用語");
    expect(markdown).toContain("共通用語");
    expect(markdown).toContain("_出典: common.txt(共通)_");
  });

  it("ソース閲覧は出典確認用の Markdown を返し、共通エントリに印を付ける", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "承認ルール", content: "業務固有", common: false },
      { category: "terms", title: "BSAD", content: "略称", common: true },
    ]);
    const state = await addSource(BOARD, "memo.txt", Buffer.from("x"));
    const { meta, markdown } = await getSourceMarkdown(BOARD, state.sources[0].id);
    expect(meta.fileName).toBe("memo.txt");
    expect(markdown).toContain("## 承認ルール");
    expect(markdown).toContain("## BSAD(業務横断の共通知識)");
  });

  it("未対応の拡張子・空の抽出はエラーにする", async () => {
    await expect(addSource(BOARD, "x.docx", Buffer.from("x"))).rejects.toThrow("未対応");
    extractMock.mockResolvedValue([]);
    await expect(addSource(BOARD, "empty.txt", Buffer.from("x"))).rejects.toThrow("抽出できません");
  });
});

describe("共通知識の管理ビュー(/knowledge)", () => {
  it("共通管理画面からの追加は AI の判定によらず必ず共通になる", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "全社承認標準", content: "500万円超は部長承認", common: false },
    ]);
    await addSource(null, "全社規程.txt", Buffer.from("x"));
    const skill = await fs.readFile(skillPath("_common", "kb-common-flows"), "utf-8");
    expect(skill).toContain("全社承認標準");
  });

  it("getKnowledgeState(null) はここで追加した資料 + 全ボードの共通知識を返す", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "共通用語", content: "c", common: true },
      { category: "flows", title: "業務ルール", content: "b", common: false },
    ]);
    await addSource(BOARD, "board.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "terms", title: "全社用語", content: "g", common: true },
    ]);
    await addSource(null, "common.txt", Buffer.from("x"));

    const state = await getKnowledgeState(null);
    // 資料一覧は共通管理画面で追加したものだけ(ボードの資料は各ボードで管理)
    expect(state.sources.map((s) => s.fileName)).toEqual(["common.txt"]);
    // カテゴリにはボードの資料から振り分けられた共通知識も集まる
    expect(state.categories.find((c) => c.category === "terms")?.count).toBe(2);
    // 業務固有の知識は共通ビューに混ざらない
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(0);
  });
});

describe("旧データ(資料単位スコープ)からの移行", () => {
  it("common フラグの無い旧エントリは、_common 由来なら共通・ボード由来なら業務固有になる", async () => {
    const { writeJson, sourcesFile, knowledgeFile } = await import(
      "@/infrastructure/context/repository"
    );
    await writeJson(sourcesFile(BOARD), [
      { id: "b1", fileName: "旧業務.txt", enabled: true, entryCount: 1, uploadedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await writeJson(knowledgeFile(BOARD), [
      { id: "e1", sourceId: "b1", category: "flows", title: "旧業務ルール", content: "x" },
    ]);
    await writeJson(sourcesFile("_common"), [
      { id: "c1", fileName: "旧共通.txt", enabled: true, entryCount: 1, uploadedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await writeJson(knowledgeFile("_common"), [
      { id: "e2", sourceId: "c1", category: "terms", title: "旧共通用語", content: "y" },
    ]);
    await renderCommonSkills();

    const common = await fs.readFile(skillPath("_common", "kb-common-terms"), "utf-8");
    expect(common).toContain("旧共通用語");
    // ボードの旧エントリは業務固有として扱われ、共通には混ざらない
    await expect(fs.access(skillPath("_common", "kb-common-flows"))).rejects.toThrow();
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-common-terms"]),
    );
  });
});

describe("エントリ単位の編集(AI 協働)", () => {
  const seedSource = async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
      { category: "terms", title: "BSAD", content: "基本設計書の略称", common: true },
    ]);
    const state = await addSource(BOARD, "設計書.txt", Buffer.from("原文: 1,000万円超は部長承認"));
    const { entries } = await getSourceEntries(BOARD, state.sources[0].id);
    return { sourceId: state.sources[0].id, entries };
  };

  it("updateEntry: 保存で edited になり skill に反映、common の付け替えもできる", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    await updateEntry(BOARD, sourceId, rule.id, {
      title: "承認ルール(改)",
      content: "2億円超は役員承認",
      common: true, // 業務固有 → 共通へ付け替え
    });

    const saved = (await getSourceEntries(BOARD, sourceId)).entries.find(
      (e) => e.id === rule.id,
    )!;
    expect(saved.edited).toBe(true);
    expect(saved.common).toBe(true);
    // 業務固有 skill からは消え、共通 skill に入る
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).rejects.toThrow();
    const common = await fs.readFile(skillPath("_common", "kb-common-flows"), "utf-8");
    expect(common).toContain("2億円超は役員承認");
  });

  it("再抽出しても edited エントリは上書きされない", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    await updateEntry(BOARD, sourceId, rule.id, {
      title: "承認ルール(人が修正)",
      content: "2億円超は役員承認",
      common: false,
    });

    extractMock.mockResolvedValue([
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認(再抽出)", common: false },
    ]);
    const state = await reextractSource(BOARD, sourceId);
    const after = (await getSourceEntries(BOARD, sourceId)).entries;
    // 人が直した方は残り、再抽出分も追加される
    expect(after.some((e) => e.title === "承認ルール(人が修正)")).toBe(true);
    expect(after.some((e) => e.content.includes("再抽出"))).toBe(true);
    expect(state.sources[0].entryCount).toBe(after.length);
  });

  it("deleteEntry: 1 件だけ消えて entryCount と skill が追従する", async () => {
    const { sourceId, entries } = await seedSource();
    const bsad = entries.find((e) => e.title === "BSAD")!;
    const state = await deleteEntry(BOARD, sourceId, bsad.id);
    expect(state.sources[0].entryCount).toBe(1);
    await expect(fs.access(skillPath("_common", "kb-common-terms"))).rejects.toThrow();
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).resolves.toBeUndefined();
  });

  it("proposeEntryRevision: 原資料の全文・現在のエントリ・指示が AI に渡る", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    reviseMock.mockResolvedValue({
      title: "承認ルール",
      content: "2億円超は役員承認",
      common: false,
      note: "指示に従い閾値を修正。原資料では1,000万円/部長承認となっています。",
    });
    const revision = await proposeEntryRevision(BOARD, sourceId, rule.id, "閾値を2億に。承認者は役員。");
    expect(revision.content).toContain("2億");
    expect(reviseMock).toHaveBeenCalledWith(
      "設計書.txt",
      expect.stringContaining("原文: 1,000万円超は部長承認"),
      expect.objectContaining({ title: "承認ルール" }),
      "閾値を2億に。承認者は役員。",
    );
  });
});
