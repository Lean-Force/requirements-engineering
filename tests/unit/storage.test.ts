// ストレージ(セッション永続化)の特性テスト。
// 版履歴の畳み込み・上限・復元・旧フォーマット互換という「静かに壊れると実害が大きい」
// 方針(pushVersion / normalizeSession)を固定する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import {
  applyChatTurn,
  listVersions,
  loadSession,
  loadStoryMap,
  restoreVersion,
  saveStoryMap,
} from "@/infrastructure/storage";
import type { StoryMap } from "@/domain";

let tmp: string;
let BOARD: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-storage-"));
  process.env.DATA_DIR = tmp;
  BOARD = (await createBoard("保存テスト")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

/** 行動 1 つの最小マップ(text で内容を変える) */
const mapWith = (text: string): StoryMap => ({
  actors: [{ id: "a1", name: "ユーザー" }],
  activities: [
    {
      id: "act1",
      actions: [{ id: "ac1", actorId: "a1", text, stories: [] }],
    },
  ],
});

describe("版履歴の方針", () => {
  it("連続するボード編集は 1 つの版に畳み込まれる(D&D 連打で履歴が溢れない)", async () => {
    await saveStoryMap(BOARD, mapWith("一"));
    await saveStoryMap(BOARD, mapWith("二"));
    const versions = await saveStoryMap(BOARD, mapWith("三"));
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toBe("edit");
    expect((await loadStoryMap(BOARD)).activities[0].actions[0].text).toBe("三");
  });

  it("マップが変わらない保存は版を積まない", async () => {
    await saveStoryMap(BOARD, mapWith("一"));
    const versions = await saveStoryMap(BOARD, mapWith("一"));
    expect(versions).toHaveLength(1);
  });

  it("チャット由来の版は編集と畳み込まれず、要約が残る", async () => {
    await saveStoryMap(BOARD, mapWith("一"));
    await applyChatTurn(BOARD, mapWith("二"), "承認のステップを追加しました", []);
    const versions = await saveStoryMap(BOARD, mapWith("三"));
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.source)).toEqual(["edit", "chat", "edit"]);
    expect(versions[1].summary).toBe("承認のステップを追加しました");
  });

  it("版は最新 10 件だけ保持し、古いものから捨てる", async () => {
    for (let i = 0; i < 13; i++) {
      // chat 由来は畳み込まれないので 1 回ごとに版が増える
      await applyChatTurn(BOARD, mapWith(`v${i}`), `turn ${i}`, []);
    }
    const versions = await listVersions(BOARD);
    expect(versions).toHaveLength(10);
    expect(versions[0].summary).toBe("turn 3"); // 0〜2 は捨てられた
    expect(versions[9].summary).toBe("turn 12");
  });

  it("復元は現在のマップを差し替えるだけで、版を増やさない(履歴が増殖しない)", async () => {
    await applyChatTurn(BOARD, mapWith("一"), "v1", []);
    await applyChatTurn(BOARD, mapWith("二"), "v2", []);
    const before = await listVersions(BOARD);
    const target = before[0];

    const { storyMap, versions } = await restoreVersion(BOARD, target.id);
    expect(storyMap.activities[0].actions[0].text).toBe("一");
    expect(versions).toHaveLength(before.length);
    await expect(restoreVersion(BOARD, "v-missing")).rejects.toThrow("見つかりません");
  });
});

describe("セッションの互換と上限", () => {
  it("旧形式(素の StoryMap だけの session.json)を読める", async () => {
    const file = path.join(tmp, "workspaces", BOARD, "session.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(mapWith("旧データ")), "utf-8");

    const session = await loadSession(BOARD);
    expect(session.storyMap.activities[0].actions[0].text).toBe("旧データ");
    expect(session.messages).toEqual([]);
    expect(session.versions).toEqual([]);
  });

  it("会話は最新 400 件だけ保持する", async () => {
    const messages = Array.from({ length: 401 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    await applyChatTurn(BOARD, mapWith("一"), "r", messages);
    const session = await loadSession(BOARD);
    expect(session.messages).toHaveLength(400);
    expect(session.messages[0].content).toBe("m1"); // 先頭 1 件が落ちる
  });
});
