// L2 API 統合テスト: ルートハンドラを直接呼び、全配線を本物のコードで通す
// (検証 → ユースケース → ドメイン → 永続化 → skill 描画 → レスポンス)。
//
// テスト戦略(TESTING.md): モックなし。LLM 境界だけ USM_FAKE_LLM=1 の
// 決定的フェイク。AI の出力はリクエスト本文のディレクティブで制御する
// (FAKEMAP: / FAKESKILLS: / KB| / CONFLICTS_JSON: / FAKESUGGEST: / REVISE|)。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as boardsPost } from "@/app/api/boards/route";
import { DELETE as boardDelete, PATCH as boardPatch } from "@/app/api/boards/[boardId]/route";
import { GET as storymapGet, PUT as storymapPut } from "@/app/api/boards/[boardId]/storymap/route";
import { POST as chatPost } from "@/app/api/boards/[boardId]/chat/route";
import { GET as sessionGet } from "@/app/api/boards/[boardId]/session/route";
import { GET as contextsGet, POST as contextsPost } from "@/app/api/boards/[boardId]/contexts/route";
import { GET as entriesGet } from "@/app/api/boards/[boardId]/contexts/[id]/entries/route";
import {
  DELETE as entryDelete,
  PATCH as entryPatch,
} from "@/app/api/boards/[boardId]/contexts/[id]/entries/[entryId]/route";
import { POST as entryRevise } from "@/app/api/boards/[boardId]/contexts/[id]/entries/[entryId]/revise/route";
import { DELETE as conflictDelete } from "@/app/api/boards/[boardId]/contexts/conflicts/[conflictId]/route";
import { POST as refinePost } from "@/app/api/boards/[boardId]/refine/route";
import { GET as knowledgeGet } from "@/app/api/knowledge/route";
import type { ChatResponse, KnowledgeState, SessionState } from "@/contracts";
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

const upload = (fileName: string, content: string) => {
  const form = new FormData();
  form.append("files", new File([content], fileName, { type: "text/plain" }));
  return new Request("http://test.local/api", { method: "POST", body: form });
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-api-"));
  process.env.DATA_DIR = tmp;
  process.env.USM_FAKE_LLM = "1";
  const res = await boardsPost(json("POST", { name: "統合テスト業務" }));
  BOARD = ((await res.json()) as { id: string }).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.USM_FAKE_LLM;
  await fs.rm(tmp, { recursive: true, force: true });
});

const params = <T extends Record<string, string>>(rest: T = {} as T) => ({
  params: { boardId: BOARD, ...rest },
});

/** 確定ストーリーと表示順を持つ、チャット配線検証用のマップ */
const FIXED_MAP: StoryMap = {
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
            { id: "s2", text: "自由なストーリー" },
          ],
        },
      ],
      storyOrder: ["s2", "s1"],
    },
  ],
};

describe("チャットターンの全配線(POST /chat)", () => {
  it("AI 出力が確定要素を壊し表示順を落としても、保存前に復元・保持される", async () => {
    await storymapPut(json("PUT", FIXED_MAP), params());

    // AI(フェイク)は確定ストーリーを改変し、storyOrder を落としたマップを返す
    const tampered = {
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        {
          id: "act1",
          actions: [
            {
              id: "ac1",
              actorId: "a1",
              text: "会計する",
              stories: [
                { id: "s1", text: "AI が書き換えた" },
                { id: "s2", text: "自由なストーリー(AI が言い換え)" },
              ],
            },
          ],
        },
      ],
    };
    const res = await chatPost(
      json("POST", {
        messages: [
          { role: "user", content: `直して\nFAKEMAP:${JSON.stringify(tampered)}\nFAKESKILLS:kb-flows` },
        ],
        storyMap: FIXED_MAP,
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatResponse;

    // 確定要素は本文・fixed とも復元される(サーバー側の砦)
    const action = body.storyMap.activities[0].actions[0];
    expect(action.fixed).toBe(true);
    const s1 = action.stories.find((s) => s.id === "s1")!;
    expect(s1.text).toBe("確定ストーリー");
    expect(s1.fixed).toBe(true);
    // AI 出力に含まれない storyOrder はサーバーが保持する
    expect(body.storyMap.activities[0].storyOrder).toEqual(["s2", "s1"]);
    // 版が chat として積まれる
    expect(body.versions?.some((v) => v.source === "chat")).toBe(true);

    // 会話が永続化され、assistant メッセージに usedSkills が残る
    const session = (await (await sessionGet(json("GET"), params())).json()) as SessionState;
    const last = session.messages[session.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.usedSkills).toEqual(["kb-flows"]);
  });

  it("同じボードへの並行ターンは直列化され、両方の版が壊れず残る", async () => {
    // 確定要素があると enforceFixed で両ターンが同一マップへ復元され「無変化 = 版を積まない」
    // が働くため、このシナリオは確定なしの土台で直列化だけを見る
    const mapWith = (text: string) => ({
      actors: [{ id: "a1", name: "店員" }],
      activities: [
        { id: "act1", actions: [{ id: "ac1", actorId: "a1", text, stories: [] }] },
      ],
    });
    const turn = (label: string) =>
      chatPost(
        json("POST", {
          messages: [
            { role: "user", content: `FAKEREPLY:${label}\nFAKEMAP:${JSON.stringify(mapWith(label))}` },
          ],
          storyMap: FIXED_MAP,
        }),
        params(),
      );
    await storymapPut(json("PUT", mapWith("初期")), params());
    const [r1, r2] = await Promise.all([turn("ターン1"), turn("ターン2")]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // 直列化により load→save が競合せず、両ターンの版が積まれている
    const session = (await (await sessionGet(json("GET"), params())).json()) as SessionState;
    const summaries = session.versions.map((v) => v.summary);
    expect(summaries).toContain("ターン1");
    expect(summaries).toContain("ターン2");
  });

  it("バリデーション: 空メッセージは 400、LLM 未設定は 500", async () => {
    const empty = await chatPost(json("POST", { messages: [], storyMap: FIXED_MAP }), params());
    expect(empty.status).toBe(400);

    delete process.env.USM_FAKE_LLM; // 接続設定なし
    const res = await chatPost(
      json("POST", { messages: [{ role: "user", content: "x" }], storyMap: FIXED_MAP }),
      params(),
    );
    expect(res.status).toBe(500);
  });

  it("存在しないボードへのターンは 404", async () => {
    const res = await chatPost(
      json("POST", { messages: [{ role: "user", content: "x" }], storyMap: FIXED_MAP }),
      { params: { boardId: "board-missing" } },
    );
    expect(res.status).toBe(404);
  });
});

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

describe("知識ベースの全配線(contexts / entries / conflicts / knowledge)", () => {
  it("アップロード → 抽出 → 振り分け → skill 描画 → 共通ビュー集約まで一気通貫", async () => {
    const res = await contextsPost(
      upload("設計書.txt", ["KB|flows|承認ルール|1,000万円超は部長承認|false", "KB|terms|BSAD|基本設計書の略称|true"].join("\n")),
      params(),
    );
    expect(res.status).toBe(200);
    const state = (await res.json()) as KnowledgeState;
    expect(state.sources).toHaveLength(1);
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(1);

    // skill がディスクに描画されている(業務固有 + 共通)
    await expect(
      fs.access(path.join(tmp, "workspaces", BOARD, ".claude", "skills", "kb-flows", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmp, "workspaces", "_common", ".claude", "skills", "kb-common-terms", "SKILL.md")),
    ).resolves.toBeUndefined();

    // 共通管理ビュー(GET /api/knowledge)に集約される
    const admin = (await (await knowledgeGet()).json()) as KnowledgeState;
    expect(admin.categories.find((c) => c.category === "terms")?.count).toBe(1);
  });

  it("エントリの編集(AI 修正案 → 保存)と削除がルート経由で通る", async () => {
    const state = (await (
      await contextsPost(upload("設計.txt", "KB|flows|承認ルール|1,000万円超は部長承認|false"), params())
    ).json()) as KnowledgeState;
    const sourceId = state.sources[0].id;
    const { entries } = (await (
      await entriesGet(json("GET"), params({ id: sourceId }))
    ).json()) as { entries: { id: string }[] };
    const entryId = entries[0].id;

    // AI 修正案(保存はされない)
    const revise = await entryRevise(
      json("POST", { instruction: "REVISE|承認ルール|2億円超は役員承認|false" }),
      params({ id: sourceId, entryId }),
    );
    expect(revise.status).toBe(200);
    const revision = (await revise.json()) as { content: string };
    expect(revision.content).toContain("2億");

    // 保存(edited = true)
    const patch = await entryPatch(
      json("PATCH", { title: "承認ルール", content: revision.content, common: false }),
      params({ id: sourceId, entryId }),
    );
    expect(patch.status).toBe(200);
    const after = (await (
      await entriesGet(json("GET"), params({ id: sourceId }))
    ).json()) as { entries: { edited?: boolean; content: string }[] };
    expect(after.entries[0].edited).toBe(true);

    // skill にも反映されている
    const skill = await fs.readFile(
      path.join(tmp, "workspaces", BOARD, ".claude", "skills", "kb-flows", "SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain("2億円超は役員承認");

    // 削除
    const del = await entryDelete(json("DELETE"), params({ id: sourceId, entryId }));
    expect(del.status).toBe(200);
    expect(((await del.json()) as KnowledgeState).sources[0].entryCount).toBe(0);
  });

  it("矛盾が検出されて state に載り、解決ルートで消える", async () => {
    await contextsPost(upload("旧規程.txt", "KB|flows|承認ルール|1,000万円超は部長承認|false"), params());
    const directive =
      'CONFLICTS_JSON:[{"topic":"承認閾値","newClaim":"2億円超は役員承認","existingSource":"旧規程.txt","existingClaim":"1,000万円超は部長承認"}]';
    const state = (await (
      await contextsPost(upload("新規程.txt", `KB|flows|承認ルール|${directive}|false`), params())
    ).json()) as KnowledgeState;
    expect(state.conflicts).toHaveLength(1);

    const res = await conflictDelete(
      json("DELETE"),
      params({ conflictId: state.conflicts[0].id }),
    );
    expect(((await res.json()) as KnowledgeState).conflicts).toHaveLength(0);
  });

  it("同名ファイルの再アップロードは資料の更新になる(ルート経由)", async () => {
    await contextsPost(upload("設計.txt", "KB|flows|旧ルール|a|false"), params());
    const state = (await (
      await contextsPost(upload("設計.txt", "KB|flows|新ルール|b|false"), params())
    ).json()) as KnowledgeState;
    expect(state.sources).toHaveLength(1);
  });

  it("バリデーション: ファイルなしは 400、抽出できない資料は 400", async () => {
    const emptyForm = new Request("http://test.local/api", {
      method: "POST",
      body: new FormData(),
    });
    expect((await contextsPost(emptyForm, params())).status).toBe(400);
    expect((await contextsPost(upload("x.txt", "NOKB"), params())).status).toBe(400);
  });
});

describe("付箋の AI 校正(POST /refine)", () => {
  it("提案が返る(マップは変更されない)", async () => {
    await storymapPut(json("PUT", FIXED_MAP), params());
    const res = await refinePost(
      json("POST", { kind: "story", text: "FAKESUGGEST:店員はレシートを渡したい。", actorName: "店員" }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestion: string }).suggestion).toContain("レシート");
    // 校正はマップを変えない
    const map = (await (await storymapGet(json("GET"), params())).json()) as StoryMap;
    expect(map.activities[0].actions[0].stories).toHaveLength(2);
  });

  it("バリデーション: kind / text 不正は 400", async () => {
    expect((await refinePost(json("POST", { kind: "story", text: "" }), params())).status).toBe(400);
    expect((await refinePost(json("POST", { kind: "x", text: "y" }), params())).status).toBe(400);
  });
});

describe("ボード管理ルート", () => {
  it("名前変更 → kb-common-maps の見出しに追従、削除でワークスペースが消える", async () => {
    // 確定要素を保存して共通マップを作る
    await storymapPut(json("PUT", FIXED_MAP), params());
    const commonMaps = path.join(
      tmp, "workspaces", "_common", ".claude", "skills", "kb-common-maps", "SKILL.md",
    );
    expect(await fs.readFile(commonMaps, "utf-8")).toContain("統合テスト業務");

    const rename = await boardPatch(json("PATCH", { name: "改名後の業務" }), params());
    expect(rename.status).toBe(200);
    expect(await fs.readFile(commonMaps, "utf-8")).toContain("改名後の業務");

    const del = await boardDelete(json("DELETE"), params());
    expect(del.status).toBe(200);
    await expect(fs.access(path.join(tmp, "workspaces", BOARD))).rejects.toThrow();
    // このボード由来の確定マップも共通から消える
    await expect(fs.access(commonMaps)).rejects.toThrow();
  });
});
