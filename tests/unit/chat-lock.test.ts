// チャットターン直列化(ボード単位ミューテックス)の特性テスト。
// 「同じボードは到着順に 1 つずつ / 別ボードは並行 / 失敗しても詰まらない」を固定する。
import { describe, expect, it } from "vitest";
import { withChatLock } from "@/infrastructure/chat-lock";

/** 手動で解決できる Promise */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("withChatLock", () => {
  it("同じボードのターンは到着順に直列実行される", async () => {
    const events: string[] = [];
    const gate = deferred();

    const first = withChatLock("lock-a", async () => {
      events.push("1:start");
      await gate.promise;
      events.push("1:end");
    });
    const second = withChatLock("lock-a", async () => {
      events.push("2:start");
    });

    await tick();
    // 先行ターンが終わるまで後続は始まらない
    expect(events).toEqual(["1:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["1:start", "1:end", "2:start"]);
  });

  it("別ボードのターンは並行して動ける", async () => {
    const events: string[] = [];
    const gate = deferred();

    const blocked = withChatLock("lock-b1", async () => {
      await gate.promise;
      events.push("b1");
    });
    await withChatLock("lock-b2", async () => {
      events.push("b2");
    });

    // b1 が詰まっていても b2 は完了している
    expect(events).toEqual(["b2"]);
    gate.resolve();
    await blocked;
    expect(events).toEqual(["b2", "b1"]);
  });

  it("先行ターンが失敗しても後続は詰まらない(失敗は呼び出し元へ返る)", async () => {
    const first = withChatLock("lock-c", async () => {
      throw new Error("LLM 呼び出しに失敗");
    });
    const second = withChatLock("lock-c", async () => "ok");

    await expect(first).rejects.toThrow("LLM 呼び出しに失敗");
    await expect(second).resolves.toBe("ok");
  });
});
