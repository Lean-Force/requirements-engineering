// 複雑システムフィクスチャ(SORA銀行 6 業務)の決定的テスト(LLM 不要)。
//
// eval(実 LLM)と同じフィクスチャを使い、AI へ渡る「材料」が正しいことを
// CI で常時保証する:
//   - シードの形(6 ボード + 共有知識)と冪等性
//   - kb-* skill の描画(off 資料の除外・description の上限)
//   - チャット常時注入のスリムさ(知識全文は入らない)と
//     ボード間齟齬チェックの材料(全業務の確定マップ)が揃っていること
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listBoards } from "@/infrastructure/boards";
import {
  buildBoardContext,
  buildChatContext,
  getKnowledgeState,
  syncKnowledgeSkills,
  workspaceDir,
} from "@/infrastructure/context";
import { loadStoryMap } from "@/infrastructure/storage";
import { BOARDS, SOURCES, seedComplexBank } from "../fixtures/complex-bank";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-cx-"));
  process.env.DATA_DIR = tmp;
  await seedComplexBank();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const readSkill = (boardId: string, name: string) =>
  fs.readFile(
    path.join(workspaceDir(boardId), ".claude", "skills", name, "SKILL.md"),
    "utf-8",
  );

describe("複雑システムのシード(SORA銀行)", () => {
  it("6 業務のボードとマップがシードされる", async () => {
    const boards = await listBoards();
    for (const b of BOARDS) {
      expect(boards.map((x) => x.name)).toContain(b.name);
      const map = await loadStoryMap(b.id);
      expect(map.activities.length).toBeGreaterThan(0);
      expect(map.actors.length).toBeGreaterThan(0);
    }
  });

  it("シードは冪等: 2 回実行してもボード・資料は重複しない", async () => {
    const before = {
      boards: (await listBoards()).length,
      sources: (await getKnowledgeState("cx-domestic")).sources.length,
    };
    await seedComplexBank();
    expect((await listBoards()).length).toBe(before.boards);
    expect((await getKnowledgeState("cx-domestic")).sources.length).toBe(
      before.sources,
    );
  });

  it("共有知識は全ボードから同じものが見える(資料 6 件・off 1 件)", async () => {
    const a = await getKnowledgeState("cx-domestic");
    const b = await getKnowledgeState("cx-support");
    expect(a.sources.length).toBe(SOURCES.length);
    expect(b.sources.length).toBe(SOURCES.length);
    expect(a.sources.filter((s) => !s.enabled).map((s) => s.fileName)).toEqual([
      "旧送金規程(2019年版).md",
    ]);
  });
});

describe("kb-* skill の描画(複雑データ)", () => {
  it("全 5 カテゴリの skill が描画され、description が上限内に収まる", async () => {
    await syncKnowledgeSkills("cx-domestic");
    for (const name of ["kb-terms", "kb-actors", "kb-flows", "kb-data", "kb-background"]) {
      const skill = await readSkill("cx-domestic", name);
      const description = skill.match(/^description: "(.+)"$/m)?.[1] ?? "";
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
    }
  });

  it("業務ルールの事実が本文に原文どおり載る(off の旧規程は載らない)", async () => {
    await syncKnowledgeSkills("cx-domestic");
    const flows = await readSkill("cx-domestic", "kb-flows");
    expect(flows).toContain("1,000万円を超える国内送金は部長承認");
    expect(flows).toContain("15:00");
    expect(flows).toContain("880");
    // off の旧送金規程(2019年版)の事実は見えない
    expect(flows).not.toContain("500万");
    expect(flows).not.toContain("14:00");
  });

  it("description に収録タイトルが入り、AI が読む判断をできる", async () => {
    await syncKnowledgeSkills("cx-foreign");
    const terms = await readSkill("cx-foreign", "kb-terms");
    const description = terms.match(/^description: "(.+)"$/m)?.[1] ?? "";
    expect(description).toContain("手数料区分");
    expect(description).toContain("制裁リスト");
  });
});

describe("チャットの常時注入(複雑データ)", () => {
  it("業務一覧・全業務の確定マップ・現在のマップが入り、知識全文は入らない", async () => {
    const context = await buildChatContext("cx-domestic");

    // 業務一覧: 6 業務すべて + 現在のボードの印
    for (const b of BOARDS) expect(context).toContain(`- ${b.name}`);
    expect(context).toContain("- 国内送金(現在のボード)");

    // ボード間の齟齬チェックの材料: 他業務の確定(fixed)済み決定が見える
    expect(context).toContain("# 各業務の合意済みマップ");
    expect(context).toContain("## 業務: 口座開設");
    expect(context).toContain("eKYC で当日中に口座開設を完了したい"); // 確定ストーリー
    expect(context).toContain("## 業務: 不正モニタリング");
    expect(context).toContain("凍結解除を役員承認で行いたい"); // 確定ストーリー

    // 現在のマップ(JSON 全体)
    expect(context).toContain("# 現在の User Story Map");
    expect(context).toContain('"text":"送金を依頼する"');

    // ドメイン知識の全文は入らない(kb-* skill でオンデマンド)
    expect(context).not.toContain("# ドメイン知識");
    expect(context).not.toContain("ISO 4217"); // kb-data にしかない事実
    expect(context).not.toContain("880"); // kb-flows にしかない事実
  });

  it("常時注入は知識全文注入(知識管理系)より小さい", async () => {
    const chat = await buildChatContext("cx-domestic");
    const full = await buildBoardContext("cx-domestic");
    expect(chat.length).toBeLessThan(full.length);
  });

  it("確定の無い業務(カスタマーサポート)は合意済みマップに現れない", async () => {
    const context = await buildChatContext("cx-domestic");
    expect(context).not.toContain("## 業務: カスタマーサポート");
  });
});
