// レベル2テスト: 「チャットの system prompt に何が注入されるか」の検証(L1)。
//
// 知識は buildKnowledgeContext が全文テキストとして組み立て、常に AI へ提示される
// (Agent Skill の選択的読込は廃止)。ここでは注入内容 — 業務の分離、on/off の反映、
// 事実の原文どおりの保持、共通知識の合成 — を決定的に保証する。
// モックは使わず、LLM 境界だけ USM_FAKE_LLM=1 のフェイク。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import {
  addSource,
  buildBoardContext,
  buildKnowledgeContext,
  reextractSource,
  setSourceEnabled,
} from "@/infrastructure/context";
import { saveStoryMap } from "@/infrastructure/storage";

let tmp: string;
let A: string; // 業務Aのボード id
let B: string; // 業務Bのボード id

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-pres-"));
  process.env.DATA_DIR = tmp;
  process.env.USM_FAKE_LLM = "1";
  A = (await createBoard("業務A")).id;
  B = (await createBoard("業務B")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.USM_FAKE_LLM;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("AI への提示内容(レベル2: system prompt 注入)", () => {
  it("業務Aの業務固有知識は業務Bの注入内容に一切現れない(分離)", async () => {
    await addSource(A, "送金.txt", Buffer.from("KB|flows|送金の承認ルール|1,000万円超は部長承認|false"));
    await addSource(B, "口座.txt", Buffer.from("KB|flows|口座開設の審査|反社チェック必須|false"));

    const a = await buildKnowledgeContext(A);
    const b = await buildKnowledgeContext(B);
    expect(a).toContain("送金の承認ルール");
    expect(a).not.toContain("口座開設");
    expect(b).toContain("口座開設の審査");
    expect(b).not.toContain("送金");
  });

  it("資料を off にすると注入内容から消え、戻すと再び現れる", async () => {
    const s1 = await addSource(A, "a.txt", Buffer.from("KB|flows|ルールA|内容A|false"));
    await addSource(A, "b.txt", Buffer.from("KB|flows|ルールB|内容B|false"));

    await setSourceEnabled(A, s1.sources[0].id, false);
    let context = await buildKnowledgeContext(A);
    expect(context).not.toContain("ルールA");
    expect(context).toContain("ルールB");

    await setSourceEnabled(A, s1.sources[0].id, true);
    context = await buildKnowledgeContext(A);
    expect(context).toContain("ルールA");
  });

  it("値域・数値などの事実が出典付きで原文どおり注入される", async () => {
    await addSource(
      A,
      "IF.txt",
      Buffer.from("KB|data|送金種別|01:即時 / 02:予約(値域: 1〜100,000,000)|false"),
    );
    const context = await buildKnowledgeContext(A);
    expect(context).toContain("01:即時 / 02:予約");
    expect(context).toContain("1〜100,000,000");
    expect(context).toContain("_出典: IF.txt_");
  });

  it("共通知識は全ボードの注入内容に現れ、再抽出で更新される", async () => {
    const state = await addSource(A, "用語集.txt", Buffer.from("KB|terms|BSAD|旧定義|true"));
    expect(await buildKnowledgeContext(B)).toContain("旧定義");

    // 原資料を改訂して再抽出 → 全ボードの注入内容が新しくなる
    await fs.writeFile(
      path.join(tmp, "workspaces", A, "sources", state.sources[0].id, "用語集.txt"),
      "KB|terms|BSAD|新定義|true",
      "utf-8",
    );
    await reextractSource(A, state.sources[0].id);
    const context = await buildKnowledgeContext(B);
    expect(context).toContain("新定義");
    expect(context).not.toContain("旧定義");
  });

  it("業務と共通はセクションで区別され、用語は常に共通側に入る", async () => {
    await addSource(
      A,
      "設計書.txt",
      // 用語は common=false と抽出されても方針で共通に強制される
      Buffer.from(["KB|flows|業務ルール|x|false", "KB|terms|用語X|x|false"].join("\n")),
    );
    const context = await buildKnowledgeContext(A);
    const ownSection = context.split("# 業務横断の共通知識")[0];
    const commonSection = context.split("# 業務横断の共通知識")[1] ?? "";
    expect(ownSection).toContain("業務ルール");
    expect(ownSection).not.toContain("用語X");
    expect(commonSection).toContain("用語X");
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
    await addSource(A, "送金.txt", Buffer.from("KB|flows|承認ルール|1,000万円超は部長承認|false"));
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
