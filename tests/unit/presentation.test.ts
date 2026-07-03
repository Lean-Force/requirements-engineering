// レベル2テスト: 「チャット直前に AI へ何が提示されるか」の検証。
//
// AI の挙動(読む/読まない)を試す前に、その判断材料 — skill 名の集合と
// SKILL.md の中身(description のトリガー情報・本文の正確さ)— が正しく
// 用意されていることを決定的に保証する。LLM は不要(抽出はモック)。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extractMock = vi.fn();
vi.mock("@/infrastructure/agent", () => ({
  extractKnowledge: (...args: unknown[]) => extractMock(...args),
}));

import {
  addSource,
  setSourceEnabled,
} from "@/infrastructure/context";
import { prepareSkillsForChat } from "@/infrastructure/context";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-pres-"));
  process.env.DATA_DIR = tmp;
  extractMock.mockReset();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const readSkill = (board: string, name: string) =>
  fs.readFile(
    path.join(tmp, "workspaces", board, ".claude", "skills", name, "SKILL.md"),
    "utf-8",
  );

const descriptionOf = (skillMd: string) =>
  /description: (.+)/.exec(skillMd)?.[1] ?? "";

describe("AI への提示内容(レベル2)", () => {
  it("業務Aの知識は業務Bのチャット準備に一切現れない(分離)", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "送金の承認ルール", content: "1,000万円超は部長承認" },
    ]);
    await addSource("board-a", "送金.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "flows", title: "口座開設の審査", content: "反社チェック必須" },
    ]);
    await addSource("board-b", "口座.txt", Buffer.from("x"));

    // skill 名は同じでも、ワークスペースが別なので中身が混ざらない
    expect(await prepareSkillsForChat("board-a")).toEqual(["kb-flows"]);
    const a = await readSkill("board-a", "kb-flows");
    const b = await readSkill("board-b", "kb-flows");
    expect(a).toContain("送金の承認ルール");
    expect(a).not.toContain("口座開設");
    expect(b).toContain("口座開設の審査");
    expect(b).not.toContain("送金");
  });

  it("2ソース中1つを off にすると、そのエントリだけが SKILL.md から消える", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "ルールA", content: "内容A" },
    ]);
    const s1 = await addSource("board-a", "a.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "flows", title: "ルールB", content: "内容B" },
    ]);
    await addSource("board-a", "b.txt", Buffer.from("x"));

    await setSourceEnabled("board-a", s1.sources[0].id, false);
    const skill = await readSkill("board-a", "kb-flows");
    expect(skill).not.toContain("ルールA");
    expect(skill).toContain("ルールB");
    // description のタイトル一覧からも消える(トリガー材料の整合)
    expect(descriptionOf(skill)).not.toContain("ルールA");
  });

  it("description にはタイトル一覧と『いつ読むか』が入り、skill 仕様の 1024 字に収まる", async () => {
    // 大量エントリで切り詰めも同時に検証する
    const many = Array.from({ length: 60 }, (_, i) => ({
      category: "terms",
      title: `とても長い用語のタイトルその${i + 1}番目`,
      content: `定義${i}`,
    }));
    extractMock.mockResolvedValue(many);
    await addSource("board-a", "用語.txt", Buffer.from("x"));

    const desc = descriptionOf(await readSkill("board-a", "kb-terms"));
    expect(desc).toContain("とても長い用語のタイトルその1番目"); // タイトルが手がかりに入る
    expect(desc).toContain("読むこと"); // いつ読むかの指示
    expect(desc).toContain("ほか"); // 切り詰め表示
    expect(desc.length).toBeLessThanOrEqual(1024); // skill 仕様の上限
  });

  it("値域・数値などの事実が SKILL.md 本文に原文どおり残る", async () => {
    extractMock.mockResolvedValue([
      {
        category: "data",
        title: "送金種別",
        content: "| 値 | 意味 |\n| --- | --- |\n| 01 | 即時 |\n| 02 | 予約 |\n値域: 1〜100,000,000",
      },
    ]);
    await addSource("board-a", "IF.txt", Buffer.from("x"));
    const skill = await readSkill("board-a", "kb-data");
    expect(skill).toContain("| 01 | 即時 |");
    expect(skill).toContain("1〜100,000,000");
    expect(skill).toContain("_出典: IF.txt_");
  });

  it("共通知識の更新は、次のチャット準備で各ボードへ同期される", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "BSAD", content: "旧定義" },
    ]);
    const state = await addSource("board-a", "用語集.txt", Buffer.from("x"), true);

    await prepareSkillsForChat("board-b");
    expect(await readSkill("board-b", "kb-common-terms")).toContain("旧定義");

    // 共通側を再抽出で更新 → 再同期で新しい内容に置き換わる
    extractMock.mockResolvedValue([
      { category: "terms", title: "BSAD", content: "新定義" },
    ]);
    const { reextractSource } = await import("@/infrastructure/context");
    await reextractSource("board-b", state.sources[0].id);
    await prepareSkillsForChat("board-b");
    const synced = await readSkill("board-b", "kb-common-terms");
    expect(synced).toContain("新定義");
    expect(synced).not.toContain("旧定義");
  });

  it("業務と共通の skill は名前と説明の書き出しで区別できる", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "業務用語", content: "x" },
    ]);
    await addSource("board-a", "業務.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "terms", title: "共通用語", content: "x" },
    ]);
    await addSource("board-a", "共通.txt", Buffer.from("x"), true);
    await prepareSkillsForChat("board-a");

    expect(descriptionOf(await readSkill("board-a", "kb-terms"))).toContain(
      "この業務のドメイン知識",
    );
    expect(descriptionOf(await readSkill("board-a", "kb-common-terms"))).toContain(
      "業務横断の共通知識",
    );
  });
});
