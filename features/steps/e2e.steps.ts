import { Given, When, Then } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { UsmWorld, BASE_URL } from "../support/world";

// 各ステップ文言は 1 回だけ定義する(Cucumber ではキーワードは相互互換)。

// 変更を伴う操作は、保存(PUT /api/storymap)の完了まで待ってから次へ進む。
// ボード編集はクライアント側で 700ms デバウンスして PUT するため、固定スリープではなく
// レスポンス待ちで確実に永続化させてからリロードする(フレーキー回避)。
async function withSave(world: UsmWorld, action: () => Promise<void>) {
  await Promise.all([
    world.page.waitForResponse(
      (r) => /\/api\/boards\/[^/]+\/storymap$/.test(r.url()) && r.request().method() === "PUT",
      { timeout: 15_000 },
    ),
    action(),
  ]);
}

// テスト用の最小マップ(アクター1・ステップ1・タスク1)を作る。
function mapWithAction(actorName: string, actionText: string) {
  return {
    actors: [{ id: "a1", name: actorName }],
    activities: [
      { id: "act1", actions: [{ id: "ac1", actorId: "a1", text: actionText, stories: [] }] },
    ],
  };
}

// ---- 共通 ----

Given("空のボードを開く", async function (this: UsmWorld) {
  await this.page.goto(`${BASE_URL}/boards/${this.boardId}`);
  await expect(this.page.locator(".backbone")).toBeVisible();
});

When("ボードを開く", async function (this: UsmWorld) {
  await this.page.goto(`${BASE_URL}/boards/${this.boardId}`);
  await expect(this.page.locator(".backbone")).toBeVisible();
});

When("ページをリロードする", async function (this: UsmWorld) {
  await this.page.reload();
  await expect(this.page.locator(".backbone")).toBeVisible();
});

// ---- アクター / タスク / ストーリーのインライン編集 ----

When("アクター {string} を追加する", async function (this: UsmWorld, name: string) {
  await this.page.locator(".add-actor-add").click();
  const input = this.page.locator(".actor-input");
  await input.fill(name);
  await withSave(this, () => input.press("Enter"));
  await expect(this.page.locator(".lane-label", { hasText: name })).toBeVisible();
});

When("ステップを1つ追加する", async function (this: UsmWorld) {
  const before = await this.page.locator(".lane-flow .step-cell").count();
  await withSave(this, () => this.page.locator(".add-activity").first().click());
  await expect
    .poll(async () => this.page.locator(".lane-flow .step-cell").count())
    .toBeGreaterThan(before);
});

When(
  "{string} の最初の空きセルにタスク {string} を追加する",
  async function (this: UsmWorld, actor: string, text: string) {
    await this.lane(actor).locator(".cell-add").first().click();
    const input = this.page.locator(".note-input");
    await input.fill(text);
    await withSave(this, () => input.press("Enter"));
    await expect(this.page.locator(".note", { hasText: text })).toBeVisible();
  },
);

When("ステップを1つ削除する", async function (this: UsmWorld) {
  this.page.once("dialog", (d) => d.accept()); // 削除確認(window.confirm)
  await withSave(this, () => this.page.locator(".del-activity").first().click());
});

When(
  "{string} の最初の空きセルでタスク追加をキャンセルする",
  async function (this: UsmWorld, actor: string) {
    await this.lane(actor).locator(".cell-add").first().click();
    const input = this.page.locator(".note-input");
    await input.press("Escape"); // Esc で取消 → 何も追加されない(PUT は飛ばない)
    await expect(input).toHaveCount(0);
  },
);

When(
  "タスク {string} にストーリー {string} を追加する",
  async function (this: UsmWorld, actionText: string, storyText: string) {
    const note = this.page.locator(".note", { hasText: actionText });
    const actionId = await note.getAttribute("data-action-id");
    const activityId = await note.getAttribute("data-activity-id");
    const col = this.page.locator(`.story-col[data-activity-id="${activityId}"]`);
    await col.locator(".story-slot-add").click();
    // 単一アクションなら直接入力、複数アクションならアクターチップが出る
    const input = this.page.locator(".story-input");
    const chip = col.locator(`.story-chip[data-action-id="${actionId}"]`);
    await expect(input.or(chip).first()).toBeVisible();
    if (await chip.isVisible()) await chip.click();
    await input.fill(storyText);
    await withSave(this, () => input.press("Enter"));
    await expect(this.page.locator(".story-card", { hasText: storyText })).toBeVisible();
  },
);

When(
  "付箋 {string} をクリックして {string} に変更する",
  async function (this: UsmWorld, oldText: string, newText: string) {
    // クリックで編集モーダルが開く(インライン編集から変更)
    await this.page.locator(".note", { hasText: oldText }).click();
    const input = this.page.locator(".story-modal-input");
    await input.fill(newText);
    await withSave(this, () => this.page.locator(".story-modal-save").click());
    await expect(this.page.locator(".note", { hasText: newText })).toBeVisible();
  },
);

When(
  "付箋 {string} をクリックして空にする",
  async function (this: UsmWorld, text: string) {
    await this.page.locator(".note", { hasText: text }).click();
    const input = this.page.locator(".story-modal-input");
    await input.fill("");
    // 空で保存 = 削除。配下ストーリーがあると確認ダイアログが出る
    this.page.once("dialog", (d) => d.accept());
    await withSave(this, () => this.page.locator(".story-modal-save").click());
  },
);

When(
  "ストーリー {string} をクリックして {string} に変更する",
  async function (this: UsmWorld, oldText: string, newText: string) {
    // クリックで編集モーダルが開く(インライン編集から変更)
    await this.page.locator(".story-card", { hasText: oldText }).click();
    const input = this.page.locator(".story-modal-input");
    await input.fill(newText);
    await withSave(this, () => this.page.locator(".story-modal-save").click());
    await expect(this.page.locator(".story-card", { hasText: newText })).toBeVisible();
  },
);

When(
  "ストーリー {string} を {string} の上へドラッグする",
  async function (this: UsmWorld, srcText: string, dstText: string) {
    const src = this.page.locator(".story-card", { hasText: srcText });
    const dst = this.page.locator(".story-card", { hasText: dstText });
    // 対象カードの上半分に落とす = その前に挿入
    await withSave(this, () => src.dragTo(dst, { targetPosition: { x: 70, y: 8 } }));
  },
);

Then(
  "ストーリー列の並びは {string} である",
  async function (this: UsmWorld, expected: string) {
    await expect
      .poll(async () =>
        (await this.page.locator(".story-card").allTextContents())
          .map((t) => t.replace(/×|📌|💬\d*/g, "").trim())
          .join(", "),
      )
      .toBe(expected);
  },
);

// ---- 共通の Then ----

Then(
  "アクター {string} の行が表示される",
  async function (this: UsmWorld, name: string) {
    await expect(this.page.locator(".lane-label", { hasText: name })).toBeVisible();
  },
);

Then("付箋 {string} が表示される", async function (this: UsmWorld, text: string) {
  await expect(this.page.locator(".note", { hasText: text })).toBeVisible();
});

Then("付箋 {string} は表示されない", async function (this: UsmWorld, text: string) {
  await expect(this.page.locator(".note", { hasText: text })).toHaveCount(0);
});

Then("ストーリー {string} が表示される", async function (this: UsmWorld, text: string) {
  await expect(this.page.locator(".story-card", { hasText: text })).toBeVisible();
});

Then(
  "ストーリー {string} は表示されない",
  async function (this: UsmWorld, text: string) {
    await expect(this.page.locator(".story-card", { hasText: text })).toHaveCount(0);
  },
);

Then(
  "ステップ列は {int} 列である",
  async function (this: UsmWorld, n: number) {
    await expect(this.page.locator(".activity-head")).toHaveCount(n);
  },
);

Then(
  "{string} の最初のセルは空欄である",
  async function (this: UsmWorld, actor: string) {
    const cell = this.lane(actor).locator(".step-cell").first();
    await expect(cell.locator(".note")).toHaveCount(0);
    await expect(cell.locator(".cell-add")).toHaveCount(1);
  },
);

// ====================================================================
// 履歴(会話の永続化・版の復元)
// ====================================================================

Given(
  "会話 {string} と AI返信 {string} が保存されている",
  async function (this: UsmWorld, user: string, assistant: string) {
    await this.seedSession({
      storyMap: { actors: [{ id: "a1", name: "ユーザー" }], activities: [] },
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ],
      versions: [],
    });
  },
);

Given("2つの版が保存されている", async function (this: UsmWorld) {
  // 版を 2 つ(古い→新しい)持ち、現在のマップは新しい方。
  await this.seedSession({
    storyMap: mapWithAction("店員", "新しいステップ"),
    messages: [],
    versions: [
      {
        id: "v1",
        createdAt: "2026-06-22T01:00:00.000Z",
        source: "chat",
        summary: "古いステップの版",
        storyMap: mapWithAction("店員", "古いステップ"),
      },
      {
        id: "v2",
        createdAt: "2026-06-22T02:00:00.000Z",
        source: "chat",
        summary: "新しいステップの版",
        storyMap: mapWithAction("店員", "新しいステップ"),
      },
    ],
  });
});

Then("チャットに {string} が表示される", async function (this: UsmWorld, text: string) {
  await expect(this.page.locator(".msg", { hasText: text })).toBeVisible();
});

Then(
  "チャットに {string} は表示されない",
  async function (this: UsmWorld, text: string) {
    await expect(this.page.locator(".msg", { hasText: text })).toHaveCount(0);
  },
);

When("会話をクリアする", async function (this: UsmWorld) {
  await Promise.all([
    this.page.waitForResponse(
      (r) => /\/api\/boards\/[^/]+\/messages$/.test(r.url()) && r.request().method() === "DELETE",
      { timeout: 15_000 },
    ),
    this.page.locator(".chat-clear").click(),
  ]);
});

When("版履歴を開く", async function (this: UsmWorld) {
  await this.page.locator(".history-toggle").click();
  await expect(this.page.locator(".history-panel")).toBeVisible();
});

When("版 {string} を復元する", async function (this: UsmWorld, summary: string) {
  const item = this.page.locator(".history-item", { hasText: summary });
  await Promise.all([
    this.page.waitForResponse(
      (r) => /\/api\/boards\/[^/]+\/versions$/.test(r.url()) && r.request().method() === "POST",
      { timeout: 15_000 },
    ),
    item.locator(".history-restore").click(),
  ]);
});

// ====================================================================
// 業務(section)ごとの表示
// ====================================================================

Given("採用と接客の2業務のマップが保存されている", async function (this: UsmWorld) {
  await this.seedSession({
    storyMap: {
      actors: [{ id: "a1", name: "店長" }, { id: "a2", name: "スタッフ" }],
      activities: [
        { id: "v1", section: "採用", actions: [{ id: "ac1", actorId: "a1", text: "求人を出す", stories: [] }] },
        { id: "v2", section: "接客", actions: [{ id: "ac2", actorId: "a2", text: "注文する", stories: [] }] },
      ],
    },
    messages: [],
    versions: [],
  });
});

Then(
  "業務 {string} が見出しとして表示される",
  async function (this: UsmWorld, name: string) {
    await expect(this.page.locator(".section-header", { hasText: name })).toBeVisible();
  },
);

Then("業務の見出しは表示されない", async function (this: UsmWorld) {
  await expect(this.page.locator(".section-header")).toHaveCount(0);
});

// ====================================================================
// キャンバス(パン・ズーム)
// ====================================================================

async function zoomPercent(world: UsmWorld): Promise<number> {
  const label = await world.page.locator(".pz-zoom").innerText();
  return Number.parseInt(label.replace("%", ""), 10);
}

async function canvasTranslateX(world: UsmWorld): Promise<number> {
  const style = (await world.page.locator(".pz-canvas").getAttribute("style")) ?? "";
  const m = style.match(/translate\(([-\d.]+)px/);
  return m ? Number.parseFloat(m[1]) : 0;
}

When("ズームインを押す", async function (this: UsmWorld) {
  await this.page.locator(".pz-controls button").last().click();
});

When("ズームアウトを押す", async function (this: UsmWorld) {
  await this.page.locator(".pz-controls button").first().click();
});

When("ズームをリセットする", async function (this: UsmWorld) {
  await this.page.locator(".pz-zoom").click();
});

Then("ズーム倍率が 100% より大きい", async function (this: UsmWorld) {
  expect(await zoomPercent(this)).toBeGreaterThan(100);
});

Then("ズーム倍率が 100% より小さい", async function (this: UsmWorld) {
  expect(await zoomPercent(this)).toBeLessThan(100);
});

Then("ズーム倍率は 100% である", async function (this: UsmWorld) {
  expect(await zoomPercent(this)).toBe(100);
});

Given("盤面の現在位置を記録する", async function (this: UsmWorld) {
  this.recordedX = await canvasTranslateX(this);
});

When("右ドラッグで盤面を移動する", async function (this: UsmWorld) {
  const box = (await this.page.locator(".pz-viewport").boundingBox())!;
  await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await this.page.mouse.down({ button: "right" });
  await this.page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 120, {
    steps: 8,
  });
  await this.page.mouse.up({ button: "right" });
});

Then("盤面の位置が変わっている", async function (this: UsmWorld) {
  const now = await canvasTranslateX(this);
  expect(Math.abs(now - (this.recordedX ?? 0))).toBeGreaterThan(20);
});
