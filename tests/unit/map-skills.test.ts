// マップ(story / バックボーン)の知識化の特性テスト。
// マップ保存(storage)をトリガーに確定済み断片がキャッシュされ、
// buildKnowledgeContext で全ボードの system prompt へ注入されることを保証する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import { saveStoryMap } from "@/infrastructure/storage";
import {
  buildKnowledgeContext,
  removeBoardMapKnowledge,
  renderMapText,
} from "@/infrastructure/context";
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

/** ステップ1: 確定済みの行動 + 確定/未確定ストーリー、ステップ2: 未確定のみ */
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

describe("マップの知識化(確定断片の注入)", () => {
  it("保存すると確定済み要素だけが業務名つきで他ボードへ注入される", async () => {
    await saveStoryMap(A, MAP);

    const context = await buildKnowledgeContext(B);
    expect(context).toContain("## 業務: 送金処理");
    expect(context).toContain("【確定】店員「会計する」");
    expect(context).toContain("レシートを渡したい");
    expect(context).not.toContain("ポイントを案内したい"); // 未確定ストーリーは載らない
    expect(context).not.toContain("袋詰め"); // 確定要素の無いステップは載らない
  });

  it("確定要素が無いマップは注入されない", async () => {
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
    expect(await buildKnowledgeContext(B)).not.toContain("合意済みマップ");
  });

  it("確定を外して保存し直すと注入からも消える", async () => {
    await saveStoryMap(A, MAP);
    expect(await buildKnowledgeContext(B)).toContain("会計する");
    await saveStoryMap(A, {
      actors: MAP.actors,
      activities: [
        {
          id: "act-1",
          actions: [
            { id: "action-1", actorId: "actor-1", text: "会計する", stories: [] },
          ],
        },
      ],
    });
    expect(await buildKnowledgeContext(B)).not.toContain("合意済みマップ");
  });

  it("ボード削除相当の掃除で注入から消える", async () => {
    await saveStoryMap(A, MAP);
    await removeBoardMapKnowledge(A);
    expect(await buildKnowledgeContext(B)).not.toContain("送金処理");
  });

  it("renderMapText はマップ全体(未確定含む・確定マーク付き)を返す(校正の注入用)", async () => {
    const text = renderMapText(MAP);
    expect(text).toContain("アクター: 店員");
    expect(text).toContain("【確定】店員「会計する」");
    expect(text).toContain("ポイントを案内したい"); // 未確定も載る
    expect(text).toContain("袋詰めする");
    expect(renderMapText({ actors: [], activities: [] })).toBe("");
  });
});
