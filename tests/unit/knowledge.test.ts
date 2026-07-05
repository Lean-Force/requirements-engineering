// 知識ベース(ユースケース + 永続化)の特性テスト(L1)。
//
// テスト戦略(TESTING.md): モックもフェイクも使わない。LLM の後段にある
// 本物の適用関数(applySource / applyReextraction / recordConflicts /
// recordBoardProposal)へリテラルの入力を渡して検証する。
// LLM を跨ぐ配線(addSource の抽出・スキャン)は L4 eval / L5 システムテストが担う。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import {
  acceptBoardProposal,
  addSource,
  applyReextraction,
  applySource,
  buildKnowledgeContext,
  deleteEntry,
  deleteSource,
  dismissBoardProposal,
  dismissConflict,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceEntries,
  getSourceMarkdown,
  recordBoardProposal,
  recordConflicts,
  setSourceEnabled,
  updateEntry,
} from "@/infrastructure/context";

let tmp: string;
let BOARD: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-kb-"));
  process.env.DATA_DIR = tmp;
  BOARD = (await createBoard("テスト業務")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

// 抽出結果のリテラル(LLM の後段へ直接渡す)
const ENTRIES_A = [
  { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
  { category: "data", title: "送金指示番号", content: "英数字12桁", common: false },
] as const;
const ENTRIES_MIXED = [
  { category: "flows", title: "承認ルール", content: "業務固有", common: false },
  { category: "terms", title: "BSAD", content: "基本設計書の略称", common: true },
] as const;

const originalPath = (scope: string, id: string, fileName: string) =>
  path.join(tmp, "workspaces", scope, "sources", id, fileName);

describe("知識ベース(抽出結果の適用)", () => {
  it("applySource: 原ファイル保存 + エントリ + 注入内容への反映", async () => {
    const state = await applySource(BOARD, "memo.txt", Buffer.from("原文"), [...ENTRIES_A]);

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].entryCount).toBe(2);
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(1);
    await expect(
      fs.readFile(originalPath(BOARD, state.sources[0].id, "memo.txt"), "utf-8"),
    ).resolves.toBe("原文");

    const context = await buildKnowledgeContext(BOARD);
    expect(context).toContain("# この業務のドメイン知識");
    expect(context).toContain("承認ルール");
    expect(context).toContain("_出典: memo.txt_");
  });

  it("common 判定どおりに業務/共通セクションへ振り分けられ、別ボードには共通だけが見える", async () => {
    await applySource(BOARD, "設計書.txt", Buffer.from("x"), [...ENTRIES_MIXED]);

    const context = await buildKnowledgeContext(BOARD);
    const own = context.split("# 業務横断の共通知識")[0];
    const common = context.split("# 業務横断の共通知識")[1] ?? "";
    expect(own).toContain("承認ルール");
    expect(common).toContain("BSAD");

    const other = (await createBoard("別業務")).id;
    const otherContext = await buildKnowledgeContext(other);
    expect(otherContext).toContain("BSAD");
    expect(otherContext).not.toContain("承認ルール");
  });

  it("スコープ方針: 用語・アクターは common=false と渡されても常に共通へ", async () => {
    await applySource(BOARD, "設計書.txt", Buffer.from("x"), [
      { category: "terms", title: "用語X", content: "定義", common: false },
      { category: "actors", title: "為替ディーラー", content: "レート確定を担当", common: false },
    ]);
    const common = (await buildKnowledgeContext(BOARD)).split("# 業務横断の共通知識")[1] ?? "";
    expect(common).toContain("用語X");
    expect(common).toContain("為替ディーラー");
  });

  it("setSourceEnabled(false) で注入から消え、戻すと再生される", async () => {
    const state = await applySource(BOARD, "memo.txt", Buffer.from("x"), [...ENTRIES_MIXED]);
    const id = state.sources[0].id;

    await setSourceEnabled(BOARD, id, false);
    expect(await buildKnowledgeContext(BOARD)).toBe("");

    await setSourceEnabled(BOARD, id, true);
    const context = await buildKnowledgeContext(BOARD);
    expect(context).toContain("承認ルール");
    expect(context).toContain("BSAD");
  });

  it("deleteSource でエントリと注入内容が消える(共通へ振り分けた分も)", async () => {
    const state = await applySource(BOARD, "memo.txt", Buffer.from("x"), [...ENTRIES_MIXED]);
    const next = await deleteSource(BOARD, state.sources[0].id);
    expect(next.sources).toHaveLength(0);
    expect(next.categories.every((c) => c.count === 0)).toBe(true);
    expect(await buildKnowledgeContext(BOARD)).toBe("");
  });

  it("applyReextraction はエントリを差し替える(原ファイル由来の再抽出の後段)", async () => {
    const state = await applySource(BOARD, "memo.txt", Buffer.from("原文"), [...ENTRIES_A]);
    const next = await applyReextraction(BOARD, state.sources[0].id, [
      { category: "background", title: "課題", content: "月末に滞留する", common: false },
    ]);
    expect(next.sources[0].entryCount).toBe(1);
    expect(next.categories.find((c) => c.category === "background")?.count).toBe(1);
    expect(next.categories.find((c) => c.category === "flows")?.count).toBe(0);
  });

  it("カテゴリ閲覧はボード + 共通をマージし、他スコープ由来の共通には(共通)が付く", async () => {
    await applySource(BOARD, "board.txt", Buffer.from("x"), [
      { category: "data", title: "ボード定義", content: "b", common: false },
    ]);
    await applySource(null, "common.txt", Buffer.from("x"), [
      { category: "data", title: "共通定義", content: "c", common: true },
    ]);

    const { markdown } = await getCategoryMarkdown(BOARD, "data");
    expect(markdown).toContain("ボード定義");
    expect(markdown).toContain("共通定義");
    expect(markdown).toContain("_出典: common.txt(共通)_");
  });

  it("ソース閲覧は出典確認用の Markdown を返し、共通エントリに印を付ける", async () => {
    const state = await applySource(BOARD, "memo.txt", Buffer.from("x"), [...ENTRIES_MIXED]);
    const { meta, markdown } = await getSourceMarkdown(BOARD, state.sources[0].id);
    expect(meta.fileName).toBe("memo.txt");
    expect(markdown).toContain("## 承認ルール");
    expect(markdown).toContain("## BSAD(業務横断の共通知識)");
  });

  it("未対応の拡張子は LLM を呼ぶ前にエラーにする", async () => {
    await expect(addSource(BOARD, "x.docx", Buffer.from("x"))).rejects.toThrow("未対応");
  });
});

describe("共通ビュー(/knowledge)", () => {
  it("共通ビュー(互換経路)への適用は判定によらず必ず共通になる", async () => {
    await applySource(null, "全社規程.txt", Buffer.from("x"), [
      { category: "flows", title: "全社承認標準", content: "500万円超は部長承認", common: false },
    ]);
    const context = await buildKnowledgeContext(BOARD);
    expect(context.split("# 業務横断の共通知識")[1] ?? "").toContain("全社承認標準");
  });

  it("getKnowledgeState(null) はここの資料 + 全ボードの共通知識を返す", async () => {
    await applySource(BOARD, "board.txt", Buffer.from("x"), [
      { category: "terms", title: "共通用語", content: "c", common: true },
      { category: "flows", title: "業務ルール", content: "b", common: false },
    ]);
    await applySource(null, "common.txt", Buffer.from("x"), [
      { category: "terms", title: "全社用語", content: "g", common: true },
    ]);

    const state = await getKnowledgeState(null);
    expect(state.sources.map((s) => s.fileName)).toEqual(["common.txt"]);
    expect(state.categories.find((c) => c.category === "terms")?.count).toBe(2);
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
      { id: "e2", sourceId: "c1", category: "data", title: "旧共通定義", content: "y" },
    ]);

    const context = await buildKnowledgeContext(BOARD);
    const own = context.split("# 業務横断の共通知識")[0];
    const common = context.split("# 業務横断の共通知識")[1] ?? "";
    expect(common).toContain("旧共通定義");
    expect(own).toContain("旧業務ルール");
    expect(common).not.toContain("旧業務ルール");
  });
});

describe("エントリ単位の編集", () => {
  const seedSource = async () => {
    const state = await applySource(BOARD, "設計書.txt", Buffer.from("x"), [...ENTRIES_MIXED]);
    const { entries } = await getSourceEntries(BOARD, state.sources[0].id);
    return { sourceId: state.sources[0].id, entries };
  };

  it("updateEntry: 保存で edited になり注入に反映、common の付け替えもできる", async () => {
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
    const context = await buildKnowledgeContext(BOARD);
    expect(context.split("# 業務横断の共通知識")[1] ?? "").toContain("2億円超は役員承認");
  });

  it("再抽出(適用)でも edited エントリは上書きされない", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    await updateEntry(BOARD, sourceId, rule.id, {
      title: "承認ルール(人が修正)",
      content: "2億円超は役員承認",
      common: false,
    });

    const state = await applyReextraction(BOARD, sourceId, [
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認(再抽出)", common: false },
    ]);
    const after = (await getSourceEntries(BOARD, sourceId)).entries;
    expect(after.some((e) => e.title === "承認ルール(人が修正)")).toBe(true);
    expect(after.some((e) => e.content.includes("再抽出"))).toBe(true);
    expect(state.sources[0].entryCount).toBe(after.length);
  });

  it("deleteEntry: 1 件だけ消えて entryCount と注入内容が追従する", async () => {
    const { sourceId, entries } = await seedSource();
    const bsad = entries.find((e) => e.title === "BSAD")!;
    const state = await deleteEntry(BOARD, sourceId, bsad.id);
    expect(state.sources[0].entryCount).toBe(1);
    const context = await buildKnowledgeContext(BOARD);
    expect(context).not.toContain("BSAD");
    expect(context).toContain("承認ルール");
  });
});

describe("鮮度(同名資料の更新)と矛盾・提案の記録", () => {
  it("同名ファイルの適用は資料の更新になる(edited は保持・原資料は差し替え)", async () => {
    const first = await applySource(BOARD, "設計.txt", Buffer.from("旧原文"), [...ENTRIES_A]);
    const sourceId = first.sources[0].id;
    const { entries } = await getSourceEntries(BOARD, sourceId);
    await updateEntry(BOARD, sourceId, entries[0].id, {
      title: "承認ルール(人が修正)",
      content: "2億円超は役員承認",
      common: false,
    });

    const next = await applySource(BOARD, "設計.txt", Buffer.from("新原文"), [
      { category: "flows", title: "新ルール", content: "即時送金は上限500万円", common: false },
    ]);

    expect(next.sources).toHaveLength(1); // 増えない = 更新
    expect(next.sources[0].id).toBe(sourceId);
    const after = (await getSourceEntries(BOARD, sourceId)).entries;
    expect(after.some((e) => e.title === "承認ルール(人が修正)")).toBe(true);
    expect(after.some((e) => e.title === "新ルール")).toBe(true);
    expect(after.some((e) => e.title === "送金指示番号")).toBe(false);
    await expect(fs.readFile(originalPath(BOARD, sourceId, "設計.txt"), "utf-8")).resolves.toBe(
      "新原文",
    );
  });

  it("recordConflicts: 矛盾が state に載り(出典 id 解決つき)、解決済みで消える", async () => {
    const old = await applySource(BOARD, "旧規程.txt", Buffer.from("x"), [...ENTRIES_A]);
    const neu = await applySource(BOARD, "新規程.txt", Buffer.from("y"), [
      { category: "flows", title: "承認ルール", content: "2億円超は役員承認", common: false },
    ]);

    await recordConflicts(BOARD, neu.sources.find((s) => s.fileName === "新規程.txt")!.id, "新規程.txt", [
      {
        topic: "送金の承認閾値",
        newClaim: "2億円超は役員承認",
        existingSource: "旧規程.txt",
        existingClaim: "1,000万円超は部長承認",
      },
    ]);
    const state = await getKnowledgeState(BOARD);
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].existingSourceId).toBe(
      old.sources.find((s) => s.fileName === "旧規程.txt")!.id,
    );

    const cleared = await dismissConflict(BOARD, state.conflicts[0].id);
    expect(cleared.conflicts).toHaveLength(0);
  });

  it("資料を削除すると関連する矛盾も消える", async () => {
    await applySource(BOARD, "旧.txt", Buffer.from("x"), [...ENTRIES_A]);
    const neu = await applySource(BOARD, "新.txt", Buffer.from("y"), [
      { category: "flows", title: "A", content: "a", common: false },
    ]);
    const newId = neu.sources.find((s) => s.fileName === "新.txt")!.id;
    await recordConflicts(BOARD, newId, "新.txt", [
      { topic: "t", newClaim: "n", existingSource: "旧.txt", existingClaim: "e" },
    ]);
    expect((await getKnowledgeState(BOARD)).conflicts).toHaveLength(1);

    const after = await deleteSource(BOARD, newId);
    expect(after.conflicts).toHaveLength(0);
  });
});

describe("新業務のボード作成提案(記録 → 承認/却下)", () => {
  const seedProposal = async () => {
    const state = await applySource(BOARD, "口座開設フロー.txt", Buffer.from("x"), [
      { category: "flows", title: "口座開設の審査", content: "反社チェック必須", common: false },
    ]);
    const sourceId = state.sources[0].id;
    await recordBoardProposal(BOARD, sourceId, "口座開設フロー.txt", {
      isNewBusiness: true,
      name: "口座開設",
      reason: "独立した業務のフローが記載されている",
    });
    return (await getKnowledgeState(BOARD)).proposals[0];
  };

  it("記録された提案が state に載る(isNewBusiness=false は載らない)", async () => {
    const proposal = await seedProposal();
    expect(proposal.name).toBe("口座開設");

    await recordBoardProposal(BOARD, proposal.sourceId, "口座開設フロー.txt", {
      isNewBusiness: false,
      name: "",
      reason: "",
    });
    expect((await getKnowledgeState(BOARD)).proposals).toHaveLength(0);
  });

  it("承認するとボードが作られ、資料・知識・原資料が新ボードへ移る", async () => {
    const proposal = await seedProposal();
    const { board, state: after } = await acceptBoardProposal(BOARD, proposal.id);

    const { listBoards } = await import("@/infrastructure/boards");
    expect((await listBoards()).some((b) => b.id === board.id && b.name === "口座開設")).toBe(true);
    expect(after.sources).toHaveLength(0);
    expect(after.proposals).toHaveLength(0);
    expect(await buildKnowledgeContext(BOARD)).not.toContain("口座開設の審査");

    const moved = await getKnowledgeState(board.id);
    expect(moved.sources.map((s) => s.fileName)).toEqual(["口座開設フロー.txt"]);
    expect(await buildKnowledgeContext(board.id)).toContain("口座開設の審査");
    await expect(
      fs.access(originalPath(board.id, moved.sources[0].id, "口座開設フロー.txt")),
    ).resolves.toBeUndefined();
  });

  it("却下すると提案だけが消える(資料は残る)", async () => {
    const proposal = await seedProposal();
    const after = await dismissBoardProposal(BOARD, proposal.id);
    expect(after.proposals).toHaveLength(0);
    expect(after.sources).toHaveLength(1);
  });

  it("資料を削除すると関連する提案も消える", async () => {
    const proposal = await seedProposal();
    const after = await deleteSource(BOARD, proposal.sourceId);
    expect(after.proposals).toHaveLength(0);
  });
});
