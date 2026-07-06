// バックボーンの連続/随時(standalone)の E2E ステップ。
// シードは本物の saveStoryMap をサーバーと同じ DATA_DIR に対して呼ぶ(モックなし)。
import { Given, When, Then } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { UsmWorld, BASE_URL, E2E_DATA_DIR } from "../support/world";

async function seedMap(
  world: UsmWorld,
  activities: { text: string; standalone?: boolean; flowName?: string }[],
) {
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = E2E_DATA_DIR;
  try {
    const { saveStoryMap } = await import("../../infrastructure/storage");
    await saveStoryMap(world.boardId, {
      actors: [{ id: "a1", name: "担当者" }],
      activities: activities.map((a, i) => ({
        id: `act-${i}`,
        ...(a.standalone ? { standalone: true } : {}),
        ...(a.flowName ? { flowName: a.flowName } : {}),
        actions: [{ id: `ac-${i}`, actorId: "a1", text: a.text, stories: [] }],
      })),
    });
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
  }
}

Given(
  "連続の場面 {string} と随時の場面 {string} があるマップ",
  async function (this: UsmWorld, flowText: string, standaloneText: string) {
    await seedMap(this, [{ text: flowText }, { text: standaloneText, standalone: true }]);
  },
);

Given(
  "連続の場面 {string} と連続の場面 {string} があるマップ",
  async function (this: UsmWorld, a: string, b: string) {
    await seedMap(this, [{ text: a }, { text: b }]);
  },
);

Then("随時バッジの付いた場面が {int} つ見える", async function (this: UsmWorld, count: number) {
  await expect(this.page.locator(".standalone-toggle.on")).toHaveCount(count);
});

Then("流れと随時の間に区切り線が見える", async function (this: UsmWorld) {
  await expect(this.page.locator(".activity-headers .flow-divider")).toBeVisible();
  await expect(this.page.locator(".flow-divider-label")).toHaveText("随時・例外");
});

Then(
  "随時の場面 {string} は右端の列にある",
  async function (this: UsmWorld, text: string) {
    // アクター行の最後の列(step-cell)がその行動を含み、standalone スタイルであること
    const cells = this.page.locator(".lane .step-cell.activity-cell");
    const last = cells.last();
    await expect(last).toContainText(text);
    await expect(last).toHaveClass(/standalone/);
  },
);

When("場面 {string} を随時に切り替える", async function (this: UsmWorld, text: string) {
  // 対象の行動を含む列の index を求め、同じ index のヘッダーのトグルを押す
  const cells = this.page.locator(".lane .step-cell.activity-cell");
  const count = await cells.count();
  let index = -1;
  for (let i = 0; i < count; i++) {
    if ((await cells.nth(i).textContent())?.includes(text)) {
      index = i;
      break;
    }
  }
  expect(index).toBeGreaterThanOrEqual(0);
  const head = this.page.locator(".activity-head").nth(index);
  await head.hover();
  await Promise.all([
    this.page.waitForResponse(
      (r) => /\/api\/boards\/[^/]+\/storymap$/.test(r.url()) && r.request().method() === "PUT",
      { timeout: 15_000 },
    ),
    head.locator(".standalone-toggle").click(),
  ]);
});

Given(
  "流れ {string} の場面 {string} と流れ {string} の場面 {string} があるマップ",
  async function (this: UsmWorld, f1: string, t1: string, f2: string, t2: string) {
    await seedMap(this, [
      { text: t1, flowName: f1 },
      { text: t2, flowName: f2 },
    ]);
  },
);

Then(
  "流れバンド {string} と {string} が見える",
  async function (this: UsmWorld, a: string, b: string) {
    await expect(this.page.locator(".flow-band-name", { hasText: a })).toBeVisible();
    await expect(this.page.locator(".flow-band-name", { hasText: b })).toBeVisible();
  },
);

When(
  "流れバンド {string} の名前を {string} に変える",
  async function (this: UsmWorld, from: string, to: string) {
    await this.page.locator(".flow-band-name", { hasText: from }).click();
    const input = this.page.locator(".flow-band-input");
    await input.fill(to);
    await Promise.all([
      this.page.waitForResponse(
        (r) => /\/api\/boards\/[^/]+\/storymap$/.test(r.url()) && r.request().method() === "PUT",
        { timeout: 15_000 },
      ),
      input.press("Enter"),
    ]);
  },
);
