// 論点(議論ポイント)の決定的テスト(LLM 不要)。
// CRUD・解決時の結論(rationale)必須・要素削除時の孤児掃除・
// チャット常時注入への描画(buildChatContext 経由)を保証する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import { buildChatContext } from "@/infrastructure/context";
import {
  addDiscussion,
  deleteDiscussion,
  listDiscussions,
  renderDiscussions,
  reopenDiscussion,
  resolveDiscussion,
} from "@/infrastructure/discussions";
import { loadStoryMap, saveStoryMap } from "@/infrastructure/storage";

let tmp: string;
let BOARD: string;

const MAP = {
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

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-disc-"));
  process.env.DATA_DIR = tmp;
  BOARD = (await createBoard("業務A")).id;
  await saveStoryMap(BOARD, MAP);
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("論点の CRUD", () => {
  it("追加した論点は open で永続化され、一覧できる", async () => {
    await addDiscussion(BOARD, { kind: "story", id: "s1" }, "上限金額は要確認");
    const points = await listDiscussions(BOARD);
    expect(points).toHaveLength(1);
    expect(points[0].status).toBe("open");
    expect(points[0].text).toBe("上限金額は要確認");
  });

  it("解決には結論(rationale)が必須で、解決後は resolution が残る", async () => {
    const p = await addDiscussion(BOARD, { kind: "board", id: BOARD }, "対象通貨の範囲");
    await expect(resolveDiscussion(BOARD, p.id, "  ")).rejects.toThrow("結論");

    await resolveDiscussion(BOARD, p.id, "まず JPY のみ。規制対応コストのため");
    const [resolved] = await listDiscussions(BOARD);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toContain("JPY のみ");
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it("reopen で未解決に戻る(結論は経緯として残る)", async () => {
    const p = await addDiscussion(BOARD, { kind: "action", id: "ac1" }, "誰が承認するか");
    await resolveDiscussion(BOARD, p.id, "店長承認とする");
    await reopenDiscussion(BOARD, p.id);
    const [point] = await listDiscussions(BOARD);
    expect(point.status).toBe("open");
    expect(point.resolution).toContain("店長"); // 経緯は消えない
  });

  it("削除できる。空テキストの追加は拒否", async () => {
    const p = await addDiscussion(BOARD, { kind: "activity", id: "act1" }, "この場の分割");
    await deleteDiscussion(BOARD, p.id);
    expect(await listDiscussions(BOARD)).toHaveLength(0);
    await expect(addDiscussion(BOARD, { kind: "board", id: BOARD }, "  ")).rejects.toThrow();
  });

  it("対象要素が消えた論点は一覧時に掃除される(board 対象は残る)", async () => {
    await addDiscussion(BOARD, { kind: "story", id: "s1" }, "ストーリーの論点");
    await addDiscussion(BOARD, { kind: "board", id: BOARD }, "ボードの論点");

    // ストーリー s1 を消したマップを保存
    await saveStoryMap(BOARD, {
      ...MAP,
      activities: [
        {
          id: "act1",
          actions: [{ id: "ac1", actorId: "a1", text: "会計する", stories: [] }],
        },
      ],
    });

    const points = await listDiscussions(BOARD);
    expect(points).toHaveLength(1);
    expect(points[0].target.kind).toBe("board");
  });
});

describe("チャット常時注入への描画", () => {
  it("未解決と解決済みが対象ラベル付きで注入される", async () => {
    await addDiscussion(BOARD, { kind: "story", id: "s1" }, "上限金額は要確認");
    const p = await addDiscussion(BOARD, { kind: "action", id: "ac1" }, "現金のみか");
    await resolveDiscussion(BOARD, p.id, "現金とカード両対応。顧客層が広いため");

    const context = await buildChatContext(BOARD);
    expect(context).toContain("# この業務の論点");
    expect(context).toContain("## 未解決");
    expect(context).toContain("[ストーリー「店員は、素早く会計したい。なぜなら行列を作りたくないからだ。」] 上限金額は要確認");
    expect(context).toContain("## 解決済み");
    expect(context).toContain("[タスク「会計する」] 現金のみか → 結論: 現金とカード両対応。顧客層が広いため");
  });

  it("論点が無ければセクションごと出ない", async () => {
    expect(await renderDiscussions(BOARD, await loadStoryMap(BOARD))).toBe("");
    expect(await buildChatContext(BOARD)).not.toContain("# この業務の論点");
  });
});
