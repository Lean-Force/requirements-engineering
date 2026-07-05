// レベル2テスト: 「チャット直前に AI へ何が提示されるか」の検証(L1)。
//
// AI の挙動(読む/読まない)を試す前に、その判断材料 — skill 名の集合と
// SKILL.md の中身(description のトリガー情報・本文の正確さ)— が正しく
// 用意されていることを決定的に保証する。モックは使わず、LLM 境界だけ
// USM_FAKE_LLM=1 のフェイク(抽出はファイル本文の KB| ディレクティブ)。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  process.env.USM_FAKE_LLM = "1";
  // 共通知識は「登録済みボード + _common」から合成されるため、ボードとして登録する
  A = (await createBoard("業務A")).id;
  B = (await createBoard("業務B")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.USM_FAKE_LLM;
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
    await addSource(A, "送金.txt", Buffer.from("KB|flows|送金の承認ルール|1,000万円超は部長承認|false"));
    await addSource(B, "口座.txt", Buffer.from("KB|flows|口座開設の審査|反社チェック必須|false"));

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
    const s1 = await addSource(A, "a.txt", Buffer.from("KB|flows|ルールA|内容A|false"));
    await addSource(A, "b.txt", Buffer.from("KB|flows|ルールB|内容B|false"));

    await setSourceEnabled(A, s1.sources[0].id, false);
    const skill = await readSkill(A, "kb-flows");
    expect(skill).not.toContain("ルールA");
    expect(skill).toContain("ルールB");
    // description のタイトル一覧からも消える(トリガー材料の整合)
    expect(descriptionOf(skill)).not.toContain("ルールA");
  });

  it("description にはタイトル一覧と『いつ読むか』が入り、skill 仕様の 1024 字に収まる", async () => {
    // 大量エントリで切り詰めも同時に検証する(用語は常に共通のため flows で行う)
    const many = Array.from(
      { length: 60 },
      (_, i) => `KB|flows|とても長いルールのタイトルその${i + 1}番目|内容${i}|false`,
    ).join("\n");
    await addSource(A, "ルール.txt", Buffer.from(many));

    const desc = descriptionOf(await readSkill(A, "kb-flows"));
    expect(desc).toContain("とても長いルールのタイトルその1番目"); // タイトルが手がかりに入る
    expect(desc).toContain("読むこと"); // いつ読むかの指示
    expect(desc).toContain("ほか"); // 切り詰め表示
    expect(desc.length).toBeLessThanOrEqual(1024); // skill 仕様の上限
  });

  it("値域・数値などの事実が SKILL.md 本文に原文どおり残る", async () => {
    await addSource(
      A,
      "IF.txt",
      Buffer.from("KB|data|送金種別|01:即時 / 02:予約(値域: 1〜100,000,000)|false"),
    );
    const skill = await readSkill(A, "kb-data");
    expect(skill).toContain("01:即時 / 02:予約");
    expect(skill).toContain("1〜100,000,000");
    expect(skill).toContain("_出典: IF.txt_");
  });

  it("共通へ振り分けられた知識の更新は、次のチャット準備で各ボードへ同期される", async () => {
    const state = await addSource(A, "用語集.txt", Buffer.from("KB|terms|BSAD|旧定義|true"));

    await prepareSkillsForChat(B);
    expect(await readSkill(B, "kb-common-terms")).toContain("旧定義");

    // 原資料を改訂して再抽出 → 再同期で新しい内容に置き換わる
    await fs.writeFile(
      path.join(tmp, "workspaces", A, "sources", state.sources[0].id, "用語集.txt"),
      "KB|terms|BSAD|新定義|true",
      "utf-8",
    );
    await reextractSource(A, state.sources[0].id);
    await prepareSkillsForChat(B);
    const synced = await readSkill(B, "kb-common-terms");
    expect(synced).toContain("新定義");
    expect(synced).not.toContain("旧定義");
  });

  it("業務と共通の skill は名前と説明の書き出しで区別でき、用語は常に共通になる", async () => {
    await addSource(
      A,
      "設計書.txt",
      // 用語は common=false と抽出されても方針で共通に強制される
      Buffer.from(["KB|flows|業務ルール|x|false", "KB|terms|用語|x|false"].join("\n")),
    );
    await prepareSkillsForChat(A);

    expect(descriptionOf(await readSkill(A, "kb-flows"))).toContain(
      "この業務のドメイン知識",
    );
    expect(descriptionOf(await readSkill(A, "kb-common-terms"))).toContain(
      "業務横断の共通知識",
    );
    // ボード側に kb-terms は作られない(用語は常に共通)
    await expect(readSkill(A, "kb-terms")).rejects.toThrow();
  });
});
