// マップ(story / バックボーン)の知識化(kb-map / kb-common-maps)の特性テスト。
// マップ保存(storage)をトリガーに、決定的にレンダリングされることを保証する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import { saveStoryMap } from "@/infrastructure/storage";
import {
  prepareSkillsForChat,
  removeBoardMapKnowledge,
} from "@/infrastructure/context";
import { boardMapSkillNames } from "@/infrastructure/context";
import type { StoryMap } from "@/domain";

let tmp: string;
let A: string;
let B: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-mapskill-"));
  process.env.DATA_DIR = tmp;
  A = (await createBoard("送金処理")).id;
  B = (await createBoard("口座開設")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const readSkill = (scope: string, name: string) =>
  fs.readFile(
    path.join(tmp, "workspaces", scope, ".claude", "skills", name, "SKILL.md"),
    "utf-8",
  );

/** 場面1: 確定済みの行動 + 確定/未確定ストーリー、場面2: 未確定のみ */
const MAP: StoryMap = {
  actors: [{ id: "actor-1", name: "店員" }],
  activities: [
    {
      id: "act-1",
      actions: [
        {
          id: "action-1",
          actorId: "actor-1",
          text: "会計する",
          fixed: true,
          stories: [
            { id: "s-1", text: "店員はレシートを渡したい。なぜなら控えが要るからだ。", fixed: true },
            { id: "s-2", text: "店員はポイントを案内したい。" },
          ],
        },
      ],
    },
    {
      id: "act-2",
      actions: [
        { id: "action-2", actorId: "actor-1", text: "袋詰めする", stories: [] },
      ],
    },
  ],
};

describe("マップの知識化", () => {
  it("保存すると kb-map(マップ全体 + 確定マーク)がレンダリングされる", async () => {
    await saveStoryMap(A, MAP);

    const skill = await readSkill(A, "kb-map");
    expect(skill).toContain("name: kb-map");
    expect(skill).toContain("アクター: 店員");
    expect(skill).toContain("【確定】店員「会計する」");
    expect(skill).toContain("【確定】店員はレシートを渡したい");
    expect(skill).toContain("店員はポイントを案内したい"); // 未確定も載る(マークなし)
    expect(skill).toContain("袋詰めする");
    expect(await boardMapSkillNames(A)).toEqual(["kb-map"]);
  });

  it("kb-common-maps には確定済みの要素だけが業務名つきで合成される", async () => {
    await saveStoryMap(A, MAP);

    const common = await readSkill("_common", "kb-common-maps");
    expect(common).toContain("## 業務: 送金処理");
    expect(common).toContain("【確定】店員「会計する」");
    expect(common).toContain("レシートを渡したい");
    expect(common).not.toContain("ポイントを案内したい"); // 未確定ストーリーは載らない
    expect(common).not.toContain("袋詰め"); // 確定要素の無い場面は載らない

    // 他業務のチャット準備に同期される
    const skills = await prepareSkillsForChat(B);
    expect(skills).toContain("kb-common-maps");
  });

  it("確定要素が無いマップは kb-common-maps に現れない(全滅なら skill ごと消える)", async () => {
    const unfixed: StoryMap = {
      actors: MAP.actors,
      activities: [
        {
          id: "act-1",
          actions: [
            { id: "action-1", actorId: "actor-1", text: "会計する", stories: [] },
          ],
        },
      ],
    };
    await saveStoryMap(A, unfixed);
    await expect(readSkill("_common", "kb-common-maps")).rejects.toThrow();
    // kb-map(ボード内向け)は未確定でも作られる
    await expect(readSkill(A, "kb-map")).resolves.toContain("会計する");
  });

  it("空のマップでは kb-map を残さない", async () => {
    await saveStoryMap(A, MAP);
    await saveStoryMap(A, { actors: [], activities: [] });
    await expect(readSkill(A, "kb-map")).rejects.toThrow();
    expect(await boardMapSkillNames(A)).toEqual([]);
  });

  it("ボード削除相当の掃除で kb-common-maps から消える", async () => {
    await saveStoryMap(A, MAP);
    await removeBoardMapKnowledge(A);
    await expect(readSkill("_common", "kb-common-maps")).rejects.toThrow();
  });
});
