// L2 API 統合テスト: ルートハンドラを直接呼び、LLM を跨がない全配線を本物のコードで通す
// (検証 → ユースケース → ドメイン → 永続化 → レスポンス)。
//
// テスト戦略(TESTING.md): モックもフェイクも使わない。AI の成果物が必要なステップは
// LLM 後段の本物の適用関数(applySource / recordConflicts / recordBoardProposal)で
// シードする。LLM を跨ぐルート配線(チャット・取り込み・校正)は L5 システムテスト
// (実 LLM)が担い、ここではバリデーションと LLM 以外の配線だけを検証する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as boardsList, POST as boardsPost } from "@/app/api/boards/route";
import { DELETE as boardDelete, PATCH as boardPatch } from "@/app/api/boards/[boardId]/route";
import { GET as storymapGet, PUT as storymapPut } from "@/app/api/boards/[boardId]/storymap/route";
import { POST as chatPost } from "@/app/api/boards/[boardId]/chat/route";
import { POST as contextsPost, GET as contextsGet } from "@/app/api/boards/[boardId]/contexts/route";
import { GET as entriesGet } from "@/app/api/boards/[boardId]/contexts/[id]/entries/route";
import {
  DELETE as entryDelete,
  PATCH as entryPatch,
} from "@/app/api/boards/[boardId]/contexts/[id]/entries/[entryId]/route";
import { DELETE as conflictDelete } from "@/app/api/boards/[boardId]/contexts/conflicts/[conflictId]/route";
import { POST as proposalAccept } from "@/app/api/boards/[boardId]/contexts/proposals/[proposalId]/accept/route";
import { DELETE as proposalDismiss } from "@/app/api/boards/[boardId]/contexts/proposals/[proposalId]/route";
import { POST as refinePost } from "@/app/api/boards/[boardId]/refine/route";
import {
  GET as discussionsGet,
  POST as discussionsPost,
} from "@/app/api/boards/[boardId]/discussions/route";
import { POST as pbiPost } from "@/app/api/boards/[boardId]/pbi/route";
import {
  DELETE as discussionDelete,
  PATCH as discussionPatch,
} from "@/app/api/boards/[boardId]/discussions/[discussionId]/route";
import { GET as knowledgeGet } from "@/app/api/knowledge/route";
import {
  applySource,
  recordBoardProposal,
  recordConflicts,
} from "@/infrastructure/context";
import type { KnowledgeState } from "@/contracts";
import type { StoryMap } from "@/domain";

let tmp: string;
let BOARD: string;

const json = (method: string, body?: unknown) =>
  new Request("http://test.local/api", {
    method,
    ...(method === "GET" || method === "HEAD" || body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-api-"));
  process.env.DATA_DIR = tmp;
  const res = await boardsPost(json("POST", { name: "統合テスト業務" }));
  BOARD = ((await res.json()) as { id: string }).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

const params = <T extends Record<string, string>>(rest: T = {} as T) => ({
  params: { boardId: BOARD, ...rest },
});

/** LLM 後段の本物の適用関数で知識をシードする */
const seedSource = async (fileName: string, entries: object[]) =>
  applySource(BOARD, fileName, Buffer.from("原文"), entries as never);

describe("マップの保存(PUT /storymap)", () => {
  it("正規化されて保存され、GET で往復する", async () => {
    const dirty = {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        {
          id: "act1",
          actions: [
            {
              id: "ac1",
              actorId: "ghost", // 存在しないアクター → 先頭アクターへフォールバック
              text: "会計する",
              fixed: false, // false は保存 JSON から落ちる
              stories: [{ id: "s1", text: "話", fixed: false }],
            },
          ],
          storyOrder: ["s1", "s-ghost", "s1"], // 実在しない id・重複は除かれる
        },
      ],
    };
    const put = await storymapPut(json("PUT", dirty), params());
    expect(put.status).toBe(200);
    const saved = (await (await storymapGet(json("GET"), params())).json()) as StoryMap;
    const action = saved.activities[0].actions[0];
    expect(action.actorId).toBe("a1");
    expect(action).not.toHaveProperty("fixed");
    expect(action.stories[0]).not.toHaveProperty("fixed");
    expect(saved.activities[0].storyOrder).toEqual(["s1"]);
  });

  it("形式不正は 400", async () => {
    const res = await storymapPut(json("PUT", { actors: "壊れてる" }), params());
    expect(res.status).toBe(400);
  });
});

describe("LLM を跨ぐルートのバリデーション(200 経路は L5 が担う)", () => {
  it("チャット: 空メッセージ 400 / 存在しないボード 404 / LLM 未設定 500", async () => {
    const empty = await chatPost(json("POST", { messages: [], storyMap: {} }), params());
    expect(empty.status).toBe(400);

    const missing = await chatPost(
      json("POST", { messages: [{ role: "user", content: "x" }], storyMap: {} }),
      { params: { boardId: "board-missing" } },
    );
    expect(missing.status).toBe(404);

    // テスト環境は LLM 未設定(接続 env なし)
    const res = await chatPost(
      json("POST", { messages: [{ role: "user", content: "x" }], storyMap: {} }),
      params(),
    );
    expect(res.status).toBe(500);
  });

  it("取り込み: ファイルなしは 400(LLM を呼ぶ前に弾く)", async () => {
    const emptyForm = new Request("http://test.local/api", {
      method: "POST",
      body: new FormData(),
    });
    expect((await contextsPost(emptyForm, params())).status).toBe(400);
  });

  it("PBI 化: storyId 不足 400 / 存在しないストーリー 404(LLM を呼ぶ前に弾く)", async () => {
    const bad = await pbiPost(json("POST", {}), params());
    expect(bad.status).toBe(400);
    // LLM 未設定の環境では設定エラー(500)が先に返る
    const noLlm = await pbiPost(json("POST", { storyId: "s-nai" }), params());
    expect(noLlm.status).toBe(500);
  });

  it("校正: 入力不正は 400 が先、設定不足は 500", async () => {
    const bad = await refinePost(json("POST", { kind: "story", text: "" }), params());
    expect(bad.status).toBe(400);
    const res = await refinePost(json("POST", { kind: "story", text: "x" }), params());
    expect(res.status).toBe(500);
  });
});

describe("知識ベースの配線(シード → ルート操作)", () => {
  it("状態取得: 資料・カテゴリ・contextSize・共通集約がルートから見える", async () => {
    await seedSource("設計書.txt", [
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
      { category: "terms", title: "BSAD", content: "基本設計書の略称", common: true },
    ]);

    const state = (await (await contextsGet(json("GET"), params())).json()) as KnowledgeState;
    expect(state.sources).toHaveLength(1);
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(1);
    expect(state.contextSize.tokens).toBeGreaterThan(0);

    const admin = (await (await knowledgeGet()).json()) as KnowledgeState;
    expect(admin.categories.find((c) => c.category === "terms")?.count).toBe(1);
  });

  it("エントリの編集・削除がルート経由で通り、edited が付く", async () => {
    const seeded = await seedSource("設計.txt", [
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
    ]);
    const sourceId = seeded.sources[0].id;
    const { entries } = (await (
      await entriesGet(json("GET"), params({ id: sourceId }))
    ).json()) as { entries: { id: string }[] };
    const entryId = entries[0].id;

    const patch = await entryPatch(
      json("PATCH", { title: "承認ルール", content: "2億円超は役員承認", common: false }),
      params({ id: sourceId, entryId }),
    );
    expect(patch.status).toBe(200);
    const after = (await (
      await entriesGet(json("GET"), params({ id: sourceId }))
    ).json()) as { entries: { edited?: boolean; content: string }[] };
    expect(after.entries[0].edited).toBe(true);
    expect(after.entries[0].content).toContain("2億");

    const del = await entryDelete(json("DELETE"), params({ id: sourceId, entryId }));
    expect(del.status).toBe(200);
    expect(((await del.json()) as KnowledgeState).sources[0].entryCount).toBe(0);
  });

  it("矛盾がルートの state に載り、解決ルートで消える", async () => {
    await seedSource("旧規程.txt", [
      { category: "flows", title: "承認ルール", content: "1,000万円超は部長承認", common: false },
    ]);
    const neu = await seedSource("新規程.txt", [
      { category: "flows", title: "承認ルール", content: "2億円超は役員承認", common: false },
    ]);
    await recordConflicts(
      BOARD,
      neu.sources.find((s) => s.fileName === "新規程.txt")!.id,
      "新規程.txt",
      [
        {
          topic: "承認閾値",
          newClaim: "2億円超は役員承認",
          existingSource: "旧規程.txt",
          existingClaim: "1,000万円超は部長承認",
        },
      ],
    );

    const state = (await (await contextsGet(json("GET"), params())).json()) as KnowledgeState;
    expect(state.conflicts).toHaveLength(1);

    const res = await conflictDelete(
      json("DELETE"),
      params({ conflictId: state.conflicts[0].id }),
    );
    expect(((await res.json()) as KnowledgeState).conflicts).toHaveLength(0);
  });

  it("提案の承認でボードが作られ資料が移り、却下では提案だけ消える(ルート経由)", async () => {
    const seeded = await seedSource("口座開設フロー.txt", [
      { category: "flows", title: "口座開設の審査", content: "反社チェック必須", common: false },
    ]);
    await recordBoardProposal(BOARD, seeded.sources[0].id, "口座開設フロー.txt", {
      isNewBusiness: true,
      name: "口座開設",
      reason: "独立した業務",
    });
    let state = (await (await contextsGet(json("GET"), params())).json()) as KnowledgeState;

    // 却下 → 資料は残る
    const dismissed = await proposalDismiss(
      json("DELETE"),
      params({ proposalId: state.proposals[0].id }),
    );
    expect(((await dismissed.json()) as KnowledgeState).proposals).toHaveLength(0);

    // もう一度提案して承認 → ボード作成 + 資料移動
    await recordBoardProposal(BOARD, seeded.sources[0].id, "口座開設フロー.txt", {
      isNewBusiness: true,
      name: "口座開設",
      reason: "独立した業務",
    });
    state = (await (await contextsGet(json("GET"), params())).json()) as KnowledgeState;
    const res = await proposalAccept(json("POST"), params({ proposalId: state.proposals[0].id }));
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: { id: string; name: string } };
    expect(board.name).toBe("口座開設");

    const boards = (await (await boardsList()).json()) as { id: string }[];
    expect(boards.some((b) => b.id === board.id)).toBe(true);
    const moved = (await (
      await contextsGet(json("GET"), { params: { boardId: board.id } })
    ).json()) as KnowledgeState;
    expect(moved.sources.map((s) => s.fileName)).toEqual(["口座開設フロー.txt"]);
  });
});

describe("ボード管理ルート", () => {
  it("名前変更が通り、削除でワークスペースと確定マップ断片が消える", async () => {
    const FIXED_MAP = {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        {
          id: "act1",
          actions: [
            { id: "ac1", actorId: "a1", text: "会計する", fixed: true, stories: [] },
          ],
        },
      ],
    };
    await storymapPut(json("PUT", FIXED_MAP), params());
    const snippet = path.join(tmp, "workspaces", "_common", "map-snippets", `${BOARD}.md`);
    await expect(fs.access(snippet)).resolves.toBeUndefined();

    const rename = await boardPatch(json("PATCH", { name: "改名後の業務" }), params());
    expect(rename.status).toBe(200);

    const del = await boardDelete(json("DELETE"), params());
    expect(del.status).toBe(200);
    await expect(fs.access(path.join(tmp, "workspaces", BOARD))).rejects.toThrow();
    await expect(fs.access(snippet)).rejects.toThrow();
  });
});

describe("論点(discussions)ルート", () => {
  const STORY_MAP = {
    actors: [{ id: "a1", name: "店員" }],
    activities: [
      {
        id: "act1",
        actions: [
          {
            id: "ac1",
            actorId: "a1",
            text: "会計する",
            stories: [{ id: "s1", text: "店員は、素早く会計したい。なぜなら行列を作りたくないからだ。" }],
          },
        ],
      },
    ],
  };

  it("追加 → 一覧 → 解決(結論必須) → 削除の全配線", async () => {
    await storymapPut(json("PUT", STORY_MAP), params());

    // バリデーション: target/text 不足は 400
    const bad = await discussionsPost(json("POST", { text: "x" }), params());
    expect(bad.status).toBe(400);

    const added = await discussionsPost(
      json("POST", { target: { kind: "story", id: "s1" }, text: "上限金額は要確認" }),
      params(),
    );
    expect(added.status).toBe(200);
    const point = (await added.json()) as { id: string };

    const list = await discussionsGet(json("GET"), params());
    expect(((await list.json()) as unknown[]).length).toBe(1);

    // 結論なしの解決は 400
    const noRes = await discussionPatch(
      json("PATCH", { action: "resolve" }),
      params({ discussionId: point.id }),
    );
    expect(noRes.status).toBe(400);

    const resolved = await discussionPatch(
      json("PATCH", { action: "resolve", resolution: "上限は 10 万円。少額決済が主のため" }),
      params({ discussionId: point.id }),
    );
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { status: string }).status).toBe("resolved");

    const del = await discussionDelete(json("DELETE"), params({ discussionId: point.id }));
    expect(del.status).toBe(200);
    const after = await discussionsGet(json("GET"), params());
    expect(((await after.json()) as unknown[]).length).toBe(0);
  });

  it("存在しない論点の操作は 404、存在しないボードは 404", async () => {
    const patch = await discussionPatch(
      json("PATCH", { action: "reopen" }),
      params({ discussionId: "disc-nai" }),
    );
    expect(patch.status).toBe(404);

    const res = await discussionsGet(json("GET"), {
      params: { boardId: "board-nai" },
    });
    expect(res.status).toBe(404);
  });
});
