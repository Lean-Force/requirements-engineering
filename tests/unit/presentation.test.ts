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
const reviseMock = vi.fn();
const detectMock = vi.fn();
vi.mock("@/infrastructure/agent", () => ({
  extractKnowledgeMulti: (...args: unknown[]) => extractMock(...args),
  reviseEntry: (...args: unknown[]) => reviseMock(...args),
  detectConflicts: (...args: unknown[]) => detectMock(...args),
}));

import { createBoard } from "@/infrastructure/boards";
import {
  addSource,
  prepareSkillsForChat,
  reextractSource,
  setSourceEnabled,
} from "@/infrastructure/context";

let tmp: string;
let A: string; // 業務Aのボード id
let B: string; // 業務Bのボード id

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-pres-"));
  process.env.DATA_DIR = tmp;
  extractMock.mockReset();
  detectMock.mockReset();
  detectMock.mockResolvedValue([]);
  // 共通知識は「登録済みボード + _common」から合成されるため、ボードとして登録する
  A = (await createBoard("業務A")).id;
  B = (await createBoard("業務B")).id;
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
      { category: "flows", title: "送金の承認ルール", content: "1,000万円超は部長承認", common: false },
    ]);
    await addSource(A, "送金.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "flows", title: "口座開設の審査", content: "反社チェック必須", common: false },
    ]);
    await addSource(B, "口座.txt", Buffer.from("x"));

    // skill 名は同じでも、ワークスペースが別なので中身が混ざらない
    expect(await prepareSkillsForChat(A)).toEqual(["kb-flows"]);
    const a = await readSkill(A, "kb-flows");
    const b = await readSkill(B, "kb-flows");
    expect(a).toContain("送金の承認ルール");
    expect(a).not.toContain("口座開設");
    expect(b).toContain("口座開設の審査");
    expect(b).not.toContain("送金");
  });

  it("2ソース中1つを off にすると、そのエントリだけが SKILL.md から消える", async () => {
    extractMock.mockResolvedValue([
      { category: "flows", title: "ルールA", content: "内容A", common: false },
    ]);
    const s1 = await addSource(A, "a.txt", Buffer.from("x"));
    extractMock.mockResolvedValue([
      { category: "flows", title: "ルールB", content: "内容B", common: false },
    ]);
    await addSource(A, "b.txt", Buffer.from("x"));

    await setSourceEnabled(A, s1.sources[0].id, false);
    const skill = await readSkill(A, "kb-flows");
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
      common: false,
    }));
    extractMock.mockResolvedValue(many);
    await addSource(A, "用語.txt", Buffer.from("x"));

    const desc = descriptionOf(await readSkill(A, "kb-terms"));
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
        common: false,
      },
    ]);
    await addSource(A, "IF.txt", Buffer.from("x"));
    const skill = await readSkill(A, "kb-data");
    expect(skill).toContain("| 01 | 即時 |");
    expect(skill).toContain("1〜100,000,000");
    expect(skill).toContain("_出典: IF.txt_");
  });

  it("共通へ振り分けられた知識の更新は、次のチャット準備で各ボードへ同期される", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "BSAD", content: "旧定義", common: true },
    ]);
    const state = await addSource(A, "用語集.txt", Buffer.from("x"));

    await prepareSkillsForChat(B);
    expect(await readSkill(B, "kb-common-terms")).toContain("旧定義");

    // 資料の持ち主(業務A)側で再抽出 → 再同期で新しい内容に置き換わる
    extractMock.mockResolvedValue([
      { category: "terms", title: "BSAD", content: "新定義", common: true },
    ]);
    await reextractSource(A, state.sources[0].id);
    await prepareSkillsForChat(B);
    const synced = await readSkill(B, "kb-common-terms");
    expect(synced).toContain("新定義");
    expect(synced).not.toContain("旧定義");
  });

  it("業務と共通の skill は名前と説明の書き出しで区別できる", async () => {
    extractMock.mockResolvedValue([
      { category: "terms", title: "業務用語", content: "x", common: false },
      { category: "terms", title: "共通用語", content: "x", common: true },
    ]);
    await addSource(A, "設計書.txt", Buffer.from("x"));
    await prepareSkillsForChat(A);

    expect(descriptionOf(await readSkill(A, "kb-terms"))).toContain(
      "この業務のドメイン知識",
    );
    expect(descriptionOf(await readSkill(A, "kb-common-terms"))).toContain(
      "業務横断の共通知識",
    );
  });
});
