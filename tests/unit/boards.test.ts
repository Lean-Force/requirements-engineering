// ボード(= 業務)管理の特性テスト。
// とくに旧シングルボード形式からの自動移行は、実データで一度きりしか走らないため
// 手動確認だけに頼らずここで固定する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBoard,
  deleteBoard,
  getBoard,
  listBoards,
  renameBoard,
} from "@/infrastructure/boards";
import { loadStoryMap } from "@/infrastructure/storage";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-boards-"));
  process.env.DATA_DIR = tmp;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("ボードの CRUD", () => {
  it("作成は名前を trim し、空名はエラーにする", async () => {
    const board = await createBoard("  送金処理  ");
    expect(board.name).toBe("送金処理");
    expect((await listBoards()).map((b) => b.id)).toContain(board.id);
    await expect(createBoard("   ")).rejects.toThrow("ボード名");
  });

  it("名前変更(空・存在しない id はエラー)", async () => {
    const board = await createBoard("旧名");
    const renamed = await renameBoard(board.id, " 新名 ");
    expect(renamed.name).toBe("新名");
    expect((await getBoard(board.id)).name).toBe("新名");
    await expect(renameBoard(board.id, " ")).rejects.toThrow("ボード名");
    await expect(renameBoard("board-missing", "x")).rejects.toThrow("見つかりません");
  });

  it("削除でワークスペースごと消え、他のボードは残る", async () => {
    const a = await createBoard("残す");
    const b = await createBoard("消す");
    const dir = path.join(tmp, "workspaces", b.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "session.json"), "{}", "utf-8");

    await deleteBoard(b.id);
    await expect(fs.access(dir)).rejects.toThrow();
    expect((await listBoards()).map((x) => x.id)).toEqual([a.id]);
    await expect(deleteBoard(b.id)).rejects.toThrow("見つかりません");
  });
});

describe("旧シングルボード形式からの移行", () => {
  it("storymap.json と workspace/ が「最初のボード」へ移る", async () => {
    // 旧形式をシード(素の StoryMap + 知識ベース一式)
    await fs.mkdir(path.join(tmp, "workspace"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "storymap.json"),
      JSON.stringify({
        actors: [{ id: "a1", name: "店員" }],
        activities: [
          { id: "act1", actions: [{ id: "ac1", actorId: "a1", text: "会計する", stories: [] }] },
        ],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(tmp, "workspace", "sources.json"),
      JSON.stringify([{ id: "s1", fileName: "旧資料.txt", enabled: true, entryCount: 0, uploadedAt: "2026-01-01T00:00:00.000Z" }]),
      "utf-8",
    );

    // 初回アクセスで移行が走る
    const boards = await listBoards();
    expect(boards).toHaveLength(1);
    expect(boards[0].name).toBe("最初のボード");

    // マップが読める(旧 storymap.json → session.json)
    const map = await loadStoryMap(boards[0].id);
    expect(map.actors[0].name).toBe("店員");
    // 知識ベース一式も移る
    const moved = path.join(tmp, "workspaces", boards[0].id, "sources.json");
    await expect(fs.access(moved)).resolves.toBeUndefined();
    // 旧ファイルは残らない
    await expect(fs.access(path.join(tmp, "storymap.json"))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, "workspace"))).rejects.toThrow();

    // 2 回目のアクセスで二重移行しない
    expect(await listBoards()).toHaveLength(1);
  });

  it("旧形式が無ければ空の一覧で初期化される", async () => {
    expect(await listBoards()).toEqual([]);
  });
});
