// レベル2テスト: 「チャットの system prompt に何が注入されるか」の検証(L1)。
//
// 知識は buildKnowledgeContext が全文テキストとして組み立て、常に AI へ提示される。
// 全資料・知識は COMMON_SCOPE に集約され、全ボードから参照される。
// ここでは注入内容 — on/off の反映、事実の原文どおりの保持、
// 共有知識の合成、更新の反映 — を決定的に保証する。モックもフェイクも使わず、
// LLM 後段の本物の適用関数(applySource / applyReextraction)へ直接入力を渡す。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard, deleteBoard, renameBoard } from "@/infrastructure/boards";
import {
  applyReextraction,
  applySource,
  buildBoardContext,
  buildKnowledgeContext,
  getSourceEntries,
  setSourceEnabled,
  updateEntry,
} from "@/infrastructure/context";
import { saveStoryMap } from "@/infrastructure/storage";

let tmp: string;
let A: string; // 業務Aのボード id
let B: string; // 業務Bのボード id

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-pres-"));
  process.env.DATA_DIR = tmp;
  A = (await createBoard("業務A")).id;
  B = (await createBoard("業務B")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("AI への提示内容(レベル2: system prompt 注入)", () => {
  it("全知識は全ボード共有: 業務Aで追加した知識は業務Bからも参照できる", async () => {
    await applySource(A, "送金.txt", Buffer.from("x"), [
      { category: "flows", title: "送金の承認ルール", content: "1,000万円超は部長承認", common: false },
    ]);
    await applySource(B, "口座.txt", Buffer.from("x"), [
      { category: "flows", title: "口座開設の審査", content: "反社チェック必須", common: false },
    ]);

    const a = await buildKnowledgeContext(A);
    const b = await buildKnowledgeContext(B);
    // 両方のボードから両方の知識が見える
    expect(a).toContain("送金の承認ルール");
    expect(a).toContain("口座開設の審査");
    expect(b).toContain("送金の承認ルール");
    expect(b).toContain("口座開設の審査");
  });

  it("資料を off にすると注入内容から消え、戻すと再び現れる", async () => {
    const s1 = await applySource(A, "a.txt", Buffer.from("x"), [
      { category: "flows", title: "ルールA", content: "内容A", common: false },
    ]);
    await applySource(A, "b.txt", Buffer.from("x"), [
      { category: "flows", title: "ルールB", content: "内容B", common: false },
    ]);

    await setSourceEnabled(A, s1.sources[0].id, false);
    let context = await buildKnowledgeContext(A);
    expect(context).not.toContain("ルールA");
    expect(context).toContain("ルールB");

    await setSourceEnabled(A, s1.sources[0].id, true);
    context = await buildKnowledgeContext(A);
    expect(context).toContain("ルールA");
  });

  it("値域・数値などの事実が出典付きで原文どおり注入される", async () => {
    await applySource(A, "IF.txt", Buffer.from("x"), [
      { category: "data", title: "送金種別", content: "01:即時 / 02:予約(値域: 1〜100,000,000)", common: false },
    ]);
    const context = await buildKnowledgeContext(A);
    expect(context).toContain("01:即時 / 02:予約");
    expect(context).toContain("1〜100,000,000");
    expect(context).toContain("_出典: IF.txt_");
  });

  it("共有知識は全ボードに現れ、再抽出(適用)で更新される", async () => {
    const state = await applySource(A, "用語集.txt", Buffer.from("旧原文"), [
      { category: "terms", title: "BSAD", content: "旧定義", common: true },
    ]);
    expect(await buildKnowledgeContext(B)).toContain("旧定義");

    await applyReextraction(A, state.sources[0].id, [
      { category: "terms", title: "BSAD", content: "新定義", common: true },
    ]);
    const context = await buildKnowledgeContext(B);
    expect(context).toContain("新定義");
    expect(context).not.toContain("旧定義");
  });

  it("知識は単一のドメイン知識セクションに統合される", async () => {
    await applySource(A, "設計書.txt", Buffer.from("x"), [
      { category: "flows", title: "業務ルール", content: "x", common: false },
      { category: "terms", title: "用語X", content: "x", common: false },
    ]);
    const context = await buildKnowledgeContext(A);
    expect(context).toContain("# ドメイン知識");
    expect(context).toContain("業務ルール");
    expect(context).toContain("用語X");
    // 業務固有/共通の分割はもうない
    expect(context).not.toContain("業務横断");
    expect(context).not.toContain("この業務の");
  });

  it("確定済みマップが業務名つきで全ボードへ注入される(未確定は載らない)", async () => {
    await saveStoryMap(A, {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        {
          id: "act1",
          actions: [
            {
              id: "ac1",
              actorId: "a1",
              text: "会計する",
              fixed: true,
              stories: [
                { id: "s1", text: "確定ストーリー", fixed: true },
                { id: "s2", text: "未確定ストーリー" },
              ],
            },
          ],
        },
      ],
    });

    const context = await buildKnowledgeContext(B);
    expect(context).toContain("# 各業務の合意済みマップ");
    expect(context).toContain("## 業務: 業務A");
    expect(context).toContain("【確定】店員「会計する」");
    expect(context).toContain("確定ストーリー");
    expect(context).not.toContain("未確定ストーリー");
  });

  it("知識もマップも無ければ注入内容は空", async () => {
    expect(await buildKnowledgeContext(A)).toBe("");
  });

  it("標準ブロックは 業務一覧 + 知識 + 現在のマップ を 1 本にまとめる", async () => {
    await applySource(A, "送金.txt", Buffer.from("x"), [
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
    ]);
    await saveStoryMap(A, {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        { id: "act1", actions: [{ id: "ac1", actorId: "a1", text: "会計する", stories: [] }] },
      ],
    });

    const block = await buildBoardContext(A);
    // 業務一覧(現在のボードに印)
    expect(block).toContain("# 業務(ボード)一覧");
    expect(block).toContain("- 業務A(現在のボード)");
    expect(block).toContain("- 業務B");
    // 知識
    expect(block).toContain("承認ルール");
    // 現在のマップ(JSON)
    expect(block).toContain("# 現在の User Story Map");
    expect(block).toContain('"text":"会計する"');
    // 共通ビュー(null)では業務一覧と知識のみで、マップは入らない
    const commonBlock = await buildBoardContext(null);
    expect(commonBlock).not.toContain("# 現在の User Story Map");
  });

});

describe("更新が注入内容へ反映される(鮮度)", () => {
  it("マップを編集して保存すると、現在の USM セクションが新しくなる", async () => {
    const mapWith = (text: string) => ({
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        { id: "act1", actions: [{ id: "ac1", actorId: "a1", text, stories: [] }] },
      ],
    });
    await saveStoryMap(A, mapWith("旧しい行動"));
    expect(await buildBoardContext(A)).toContain("旧しい行動");

    await saveStoryMap(A, mapWith("新しい行動"));
    const block = await buildBoardContext(A);
    expect(block).toContain("新しい行動");
    expect(block).not.toContain("旧しい行動");
  });

  it("エントリを編集して保存すると、注入の本文が差し替わる", async () => {
    const state = await applySource(A, "設計.txt", Buffer.from("x"), [
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
    ]);
    const { entries } = await getSourceEntries(A, state.sources[0].id);
    await updateEntry(A, state.sources[0].id, entries[0].id, {
      title: "承認ルール",
      content: "2億円超は役員承認",
      common: false,
    });

    const block = await buildBoardContext(A);
    expect(block).toContain("2億円超は役員承認");
    expect(block).not.toContain("1,000万円超は部長承認");
  });

  it("同名資料の再アップロードで注入が新しい内容に置き換わる(修正済みは残る)", async () => {
    const first = await applySource(A, "設計.txt", Buffer.from("旧原文"), [
      { category: "flows", title: "旧ルール", content: "旧の内容", common: false },
      { category: "flows", title: "直したルール", content: "人が直す前", common: false },
    ]);
    const { entries } = await getSourceEntries(A, first.sources[0].id);
    const edited = entries.find((e) => e.title === "直したルール")!;
    await updateEntry(A, first.sources[0].id, edited.id, {
      title: "直したルール",
      content: "人が直した内容",
      common: false,
    });

    await applySource(A, "設計.txt", Buffer.from("新原文"), [
      { category: "flows", title: "新ルール", content: "新の内容", common: false },
    ]);
    const block = await buildBoardContext(A);
    expect(block).toContain("新の内容"); // 改訂版が入る
    expect(block).not.toContain("旧の内容"); // 未編集の旧エントリは消える
    expect(block).toContain("人が直した内容"); // ✍️ 修正済みは保持される
  });

  it("ボード名を変えると、業務一覧と合意済みマップの見出しが追従する", async () => {
    await saveStoryMap(A, {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        {
          id: "act1",
          actions: [
            { id: "ac1", actorId: "a1", text: "会計する", fixed: true, stories: [] },
          ],
        },
      ],
    });
    expect(await buildBoardContext(B)).toContain("## 業務: 業務A");

    await renameBoard(A, "改名後の業務");
    const block = await buildBoardContext(B);
    expect(block).toContain("- 改名後の業務");
    expect(block).toContain("## 業務: 改名後の業務");
    expect(block).not.toContain("業務A");
  });

  it("ボードを削除しても共有知識は消えない(確定マップ断片は掃除される)", async () => {
    await applySource(A, "用語.txt", Buffer.from("x"), [
      { category: "terms", title: "Aの用語", content: "定義", common: true },
    ]);
    await saveStoryMap(A, {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        {
          id: "act1",
          actions: [
            { id: "ac1", actorId: "a1", text: "会計する", fixed: true, stories: [] },
          ],
        },
      ],
    });
    let block = await buildBoardContext(B);
    expect(block).toContain("Aの用語");
    expect(block).toContain("## 業務: 業務A");

    await deleteBoard(A);
    block = await buildBoardContext(B);
    expect(block).not.toContain("- 業務A");
    // 共有知識は残る(資料は _common にあるためボード削除で消えない)
    expect(block).toContain("Aの用語");
    // 確定マップ断片は掃除される(孤立ボードの断片は confirmedMapSections で除外)
    expect(block).not.toContain("## 業務: 業務A");
  });

  it("contextSize が注入サイズを追従する(追加で増え、削除で減る)", async () => {
    const { getKnowledgeState, deleteSource } = await import("@/infrastructure/context");
    const empty = await getKnowledgeState(A);
    expect(empty.contextSize.windowTokens).toBe(200_000);
    const before = empty.contextSize.tokens;

    const state = await applySource(A, "設計.txt", Buffer.from("x"), [
      { category: "flows", title: "承認ルール", content: "1,000万円を超える送金は部長承認が必要", common: false },
    ]);
    expect(state.contextSize.tokens).toBeGreaterThan(before);
    expect(state.contextSize.chars).toBeGreaterThan(0);

    const after = await deleteSource(A, state.sources[0].id);
    expect(after.contextSize.tokens).toBeLessThan(state.contextSize.tokens);
  });
});
