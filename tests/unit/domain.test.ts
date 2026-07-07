// domain 層の特性テスト。リファクタリング前の挙動を固定し、分割後も同じであることを保証する。
import { describe, expect, it } from "vitest";
import {
  addStory,
  emptyStoryMap,
  enforceFixed,
  moveStory,
  normalizeStoryMap,
  orderedStories,
  preserveStoryOrder,
  removeActor,
  renameStory,
  reorderStoryInColumn,
  setActionFixed,
  setStoryFixed,
  setActivityStandalone,
  setFlowName,
  setReleases,
  setStoryRelease,
} from "@/domain";
import type { StoryMap } from "@/domain";

// テスト用の代表的なマップ(2アクター・2場面・確定/表示順の材料つき)
function sample(): StoryMap {
  return {
    actors: [
      { id: "a1", name: "店員" },
      { id: "a2", name: "お客様" },
    ],
    activities: [
      {
        id: "act1",
        actions: [
          {
            id: "ac1",
            actorId: "a1",
            text: "会計する",
            stories: [
              { id: "s1", text: "一" },
              { id: "s2", text: "二" },
              { id: "s3", text: "三", fixed: true },
            ],
          },
          { id: "ac2", actorId: "a2", text: "支払う", stories: [{ id: "s4", text: "四" }] },
        ],
      },
      {
        id: "act2",
        actions: [{ id: "ac3", actorId: "a1", text: "見送る", stories: [] }],
      },
    ],
  };
}

const columnIds = (m: StoryMap, activityId: string) =>
  orderedStories(m.activities.find((a) => a.id === activityId)!).map((p) => p.story.id);

describe("normalizeStoryMap", () => {
  it("アクター不在なら既定アクターを補う", () => {
    const n = normalizeStoryMap({ actors: [], activities: [] });
    expect(n.actors).toHaveLength(1);
  });

  it("無効な actorId を先頭アクターへ倒す", () => {
    const m = sample();
    m.activities[0].actions[0].actorId = "ghost";
    const n = normalizeStoryMap(m);
    expect(n.activities[0].actions[0].actorId).toBe("a1");
  });

  it("fixed は true のときだけ残す", () => {
    const n = normalizeStoryMap(sample());
    const stories = n.activities[0].actions[0].stories;
    expect(stories[0]).not.toHaveProperty("fixed");
    expect(stories[2].fixed).toBe(true);
  });

  it("storyOrder は実在 id のみ・重複なしに掃除する", () => {
    const m = sample();
    m.activities[0].storyOrder = ["s2", "ghost", "s2", "s1"];
    const n = normalizeStoryMap(m);
    expect(n.activities[0].storyOrder).toEqual(["s2", "s1"]);
  });

  it("空の storyOrder はフィールドごと落とす", () => {
    const m = sample();
    m.activities[0].storyOrder = ["ghost"];
    const n = normalizeStoryMap(m);
    expect(n.activities[0]).not.toHaveProperty("storyOrder");
  });
});

describe("集約操作", () => {
  it("addStory / renameStory は対象だけを変える", () => {
    let m = addStory(sample(), "act2", "ac3", "新しい");
    expect(m.activities[1].actions[0].stories).toHaveLength(1);
    m = renameStory(m, "act1", "ac1", "s1", "壱");
    expect(m.activities[0].actions[0].stories[0].text).toBe("壱");
    expect(m.activities[0].actions[0].stories[1].text).toBe("二");
  });

  it("removeActor はそのアクターの行動をカスケード削除する", () => {
    const m = removeActor(sample(), "a2");
    expect(m.activities[0].actions.map((a) => a.id)).toEqual(["ac1"]);
  });

  it("setStoryFixed / setActionFixed の付け外し", () => {
    let m = setStoryFixed(sample(), "act1", "ac1", "s1", true);
    expect(m.activities[0].actions[0].stories[0].fixed).toBe(true);
    m = setStoryFixed(m, "act1", "ac1", "s1", false);
    expect(m.activities[0].actions[0].stories[0]).not.toHaveProperty("fixed");
    m = setActionFixed(m, "act1", "ac1", true);
    expect(m.activities[0].actions[0].fixed).toBe(true);
  });
});

describe("moveStory(行動間の付け替え)", () => {
  it("同一行動内で上下できる(fixed 保持)", () => {
    const up = moveStory(sample(), { activityId: "act1", actionId: "ac1", storyId: "s3" }, { activityId: "act1", actionId: "ac1", index: 0 });
    expect(up.activities[0].actions[0].stories.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(up.activities[0].actions[0].stories[0].fixed).toBe(true);

    const down = moveStory(sample(), { activityId: "act1", actionId: "ac1", storyId: "s1" }, { activityId: "act1", actionId: "ac1", index: 3 });
    expect(down.activities[0].actions[0].stories.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
  });

  it("別の行動へ付け替えられる", () => {
    const m = moveStory(sample(), { activityId: "act1", actionId: "ac1", storyId: "s2" }, { activityId: "act1", actionId: "ac2", index: 0 });
    expect(m.activities[0].actions[0].stories.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(m.activities[0].actions[1].stories.map((s) => s.id)).toEqual(["s2", "s4"]);
  });

  it("移動先が無ければ何もしない", () => {
    const base = sample();
    const m = moveStory(base, { activityId: "act1", actionId: "ac1", storyId: "s1" }, { activityId: "x", actionId: "y", index: 0 });
    expect(m).toEqual(base);
  });
});

describe("列内の表示順(storyOrder)", () => {
  it("reorderStoryInColumn で別アクターのストーリーとも並び替えられる", () => {
    const m = reorderStoryInColumn(sample(), "act1", "s4", 0);
    expect(columnIds(m, "act1")).toEqual(["s4", "s1", "s2", "s3"]);
    // 所属は変わらない
    expect(m.activities[0].actions[1].stories.map((s) => s.id)).toEqual(["s4"]);
  });

  it("下方向への移動は挿入位置を詰める", () => {
    const m = reorderStoryInColumn(sample(), "s" === "s" ? "act1" : "", "s1", 3);
    expect(columnIds(m, "act1")).toEqual(["s2", "s3", "s1", "s4"]);
  });

  it("preserveStoryOrder は AI 出力へ順序を引き継ぎ、新規は末尾・消えた id は掃除", () => {
    const ordered = reorderStoryInColumn(sample(), "act1", "s4", 0);
    // AI 出力: storyOrder なし、s2 を削除、s5 を追加
    const ai = sample();
    ai.activities[0].actions[0].stories = [
      { id: "s1", text: "一" },
      { id: "s3", text: "三", fixed: true },
      { id: "s5", text: "五" },
    ];
    const merged = normalizeStoryMap(preserveStoryOrder(ordered, ai));
    expect(columnIds(merged, "act1")).toEqual(["s4", "s1", "s3", "s5"]);
    expect(merged.activities[0].storyOrder).toEqual(["s4", "s1", "s3"]);
  });
});

describe("enforceFixed(確定要素の保護)", () => {
  const before = () => {
    let m = sample();
    m = setActionFixed(m, "act1", "ac1", true);
    return m; // ac1(fixed) 配下に s3(fixed) を含む
  };

  it("確定ストーリーの改変・削除・fixed剥がしを復元する", () => {
    const b = before();
    // 改変 + fixed 剥がし
    const tampered: StoryMap = JSON.parse(JSON.stringify(b));
    tampered.activities[0].actions[0].stories = [
      { id: "s1", text: "一" },
      { id: "s3", text: "書き換え" },
    ];
    const r = enforceFixed(b, tampered);
    const s3 = r.activities[0].actions[0].stories.find((s) => s.id === "s3")!;
    expect(s3.text).toBe("三");
    expect(s3.fixed).toBe(true);
  });

  it("確定行動が消されたら配下ストーリーごと復元する", () => {
    const b = before();
    const wiped: StoryMap = JSON.parse(JSON.stringify(b));
    wiped.activities[0].actions = wiped.activities[0].actions.filter((a) => a.id !== "ac1");
    const r = enforceFixed(b, wiped);
    const ac1 = r.activities[0].actions.find((a) => a.id === "ac1")!;
    expect(ac1.fixed).toBe(true);
    expect(ac1.text).toBe("会計する");
    expect(ac1.stories.map((s) => s.id)).toContain("s3");
  });

  it("場面ごと消されたら場面を再生する", () => {
    const b = before();
    const r = enforceFixed(b, { actors: b.actors, activities: [] });
    const act1 = r.activities.find((a) => a.id === "act1")!;
    expect(act1.actions.some((a) => a.id === "ac1")).toBe(true);
  });

  it("確定要素の移動は許容する(内容とフラグだけ守る)", () => {
    const b = before();
    const moved: StoryMap = JSON.parse(JSON.stringify(b));
    // ac1 を act2 へ移動
    const ac1 = moved.activities[0].actions.find((a) => a.id === "ac1")!;
    moved.activities[0].actions = moved.activities[0].actions.filter((a) => a.id !== "ac1");
    moved.activities[1].actions.push(ac1);
    const r = enforceFixed(b, moved);
    expect(r.activities[1].actions.some((a) => a.id === "ac1")).toBe(true);
    expect(r.activities[0].actions.some((a) => a.id === "ac1")).toBe(false);
  });

  it("未確定要素の削除は許容する", () => {
    const b = before();
    const pruned: StoryMap = JSON.parse(JSON.stringify(b));
    pruned.activities[0].actions[0].stories = pruned.activities[0].actions[0].stories.filter(
      (s) => s.id === "s3",
    );
    const r = enforceFixed(b, pruned);
    expect(r.activities[0].actions[0].stories.map((s) => s.id)).toEqual(["s3"]);
  });

  it("emptyStoryMap には既定アクターが1人いる", () => {
    expect(emptyStoryMap().actors).toHaveLength(1);
  });
});

describe("applyAiUpdate(AI 出力の取り込みパイプライン)", () => {
  it("正規化・確定保護・表示順引き継ぎを正しい順序で適用する", async () => {
    const { applyAiUpdate } = await import("@/domain");
    // before: s3 が確定、列の表示順は s4 が先頭
    let before = setStoryFixed(sample(), "act1", "ac1", "s3", true);
    before = reorderStoryInColumn(before, "act1", "s4", 0);

    // AI 出力: s3 を削除(違反)+ actorId が無効 + storyOrder なし + s5 追加
    const ai: StoryMap = JSON.parse(JSON.stringify(sample()));
    ai.activities[0].actions[0].stories = [
      { id: "s1", text: "一" },
      { id: "s5", text: "五" },
    ];
    ai.activities[0].actions[1].actorId = "ghost";

    const r = applyAiUpdate(before, ai);
    // 確定 s3 が復元されている
    const s3 = r.activities[0].actions[0].stories.find((s) => s.id === "s3");
    expect(s3?.fixed).toBe(true);
    // 無効な actorId は正規化される
    expect(r.activities[0].actions[1].actorId).toBe("a1");
    // 表示順: s4 先頭が維持され、消えた id は掃除済み・新規は末尾
    expect(columnIds(r, "act1")[0]).toBe("s4");
    expect(r.activities[0].storyOrder).not.toContain("s2");
  });
});

describe("随時(standalone)の場面 — 連続と非連続の区別", () => {
  const flow = (id: string) => ({
    id,
    actions: [{ id: `ac-${id}`, actorId: "a1", text: id, stories: [] }],
  });

  it("normalize: standalone は true のときだけ残り、随時は末尾へまとまる(安定順)", () => {
    const m = normalizeStoryMap({
      actors: [{ id: "a1", name: "A" }],
      activities: [
        { ...flow("随時1"), standalone: true },
        flow("流れ1"),
        { ...flow("流れ2"), standalone: false } as never,
        { ...flow("随時2"), standalone: true },
      ],
    });
    expect(m.activities.map((a) => a.id)).toEqual(["流れ1", "流れ2", "随時1", "随時2"]);
    expect(m.activities[0]).not.toHaveProperty("standalone");
    expect(m.activities[1]).not.toHaveProperty("standalone");
    expect(m.activities[2].standalone).toBe(true);
    expect(m.activities[3].standalone).toBe(true);
  });

  it("setActivityStandalone: 随時化で末尾へ、戻すと流れの並びへ復帰する", () => {
    const base = normalizeStoryMap({
      actors: [{ id: "a1", name: "A" }],
      activities: [flow("一"), flow("二"), flow("三")],
    });
    const moved = setActivityStandalone(base, "ac-一".replace("ac-", ""), true);
    expect(moved.activities.map((a) => a.id)).toEqual(["二", "三", "一"]);
    expect(moved.activities[2].standalone).toBe(true);

    const back = setActivityStandalone(moved, "一", false);
    expect(back.activities.map((a) => a.id)).toEqual(["二", "三", "一"]);
    expect(back.activities[2]).not.toHaveProperty("standalone");
  });
});

describe("小さな流れ(flowName)のクラスタ化", () => {
  const scene = (id: string, flowName?: string) => ({
    id,
    ...(flowName ? { flowName } : {}),
    actions: [{ id: `ac-${id}`, actorId: "a1", text: id, stories: [] }],
  });

  it("normalize: 同じ流れの場面は初出順で隣接にまとまり、名前なしは単独で順序を保つ", () => {
    const m = normalizeStoryMap({
      actors: [{ id: "a1", name: "A" }],
      activities: [
        scene("受付1", "受付"),
        scene("審査1", "審査"),
        scene("受付2", "受付"), // 離れて置かれても受付群に寄る
        scene("単独"),
        scene("審査2", "審査"),
      ],
    });
    expect(m.activities.map((a) => a.id)).toEqual(["受付1", "受付2", "審査1", "審査2", "単独"]);
    expect(m.activities[0].flowName).toBe("受付");
    expect(m.activities[4]).not.toHaveProperty("flowName");
  });

  it("随時の場面には flowName が付かない(正規化で除去)", () => {
    const m = normalizeStoryMap({
      actors: [{ id: "a1", name: "A" }],
      activities: [{ ...scene("随時1", "受付"), standalone: true }],
    });
    expect(m.activities[0].standalone).toBe(true);
    expect(m.activities[0]).not.toHaveProperty("flowName");
  });

  it("setFlowName: 場面群への命名・改名・解除(空文字)ができる", () => {
    const base = normalizeStoryMap({
      actors: [{ id: "a1", name: "A" }],
      activities: [scene("一"), scene("二")],
    });
    const named = setFlowName(base, ["一", "二"], "受付");
    expect(named.activities.map((a) => a.flowName)).toEqual(["受付", "受付"]);

    const renamed = setFlowName(named, ["一", "二"], "受付・確認");
    expect(renamed.activities[0].flowName).toBe("受付・確認");

    const cleared = setFlowName(renamed, ["一", "二"], "  ");
    expect(cleared.activities[0]).not.toHaveProperty("flowName");
  });
});

describe("リリースライン", () => {
  const base = normalizeStoryMap({
    actors: [{ id: "a1", name: "A" }],
    activities: [
      {
        id: "act1",
        actions: [
          {
            id: "ac1",
            actorId: "a1",
            text: "x",
            stories: [
              { id: "s1", text: "MVP", release: 0 },
              { id: "s2", text: "R2", release: 1 },
              { id: "s3", text: "未指定" },
            ],
          },
        ],
      },
    ],
    releases: [{ name: "MVP" }, { name: "フェーズ2" }],
  });

  it("normalize: release 0 は省略され、正の整数だけ残る。releases も保持される", () => {
    const s1 = base.activities[0].actions[0].stories.find((s) => s.id === "s1")!;
    const s2 = base.activities[0].actions[0].stories.find((s) => s.id === "s2")!;
    const s3 = base.activities[0].actions[0].stories.find((s) => s.id === "s3")!;
    expect(s1.release).toBe(0); // 0 = MVP(明示的に入れた)
    expect(s2.release).toBe(1);
    expect(s3).not.toHaveProperty("release"); // 未指定 = 未分類
    expect(base.releases).toEqual([{ name: "MVP" }, { name: "フェーズ2" }]);
  });

  it("setStoryRelease: ストーリーのリリースを変更できる", () => {
    const moved = setStoryRelease(base, "s1", 1);
    expect(moved.activities[0].actions[0].stories.find((s) => s.id === "s1")!.release).toBe(1);
  });

  it("setReleases: リリース定義を更新できる", () => {
    const updated = setReleases(base, [{ name: "Alpha" }, { name: "Beta" }, { name: "GA" }]);
    expect(updated.releases).toEqual([{ name: "Alpha" }, { name: "Beta" }, { name: "GA" }]);
  });
});
