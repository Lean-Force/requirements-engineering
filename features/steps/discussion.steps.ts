// 論点(議論ポイント)の E2E ステップ。バッジ → モーダルでの追加・解決・削除と、
// ヘッダーの未解決カウントの追従を UI 操作で検証する。
import { When, Then } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { UsmWorld } from "../support/world";

When(
  "ストーリー {string} に論点 {string} を追加する",
  async function (this: UsmWorld, storyText: string, pointText: string) {
    const card = this.page.locator(".story-card", { hasText: storyText });
    await card.hover();
    await card.locator(".disc-badge").click();
    await this.page.locator(".discussion-add textarea").fill(pointText);
    await this.page.locator(".discussion-add button").click();
    await expect(
      this.page.locator(".discussion-item.open", { hasText: pointText }),
    ).toBeVisible();
    await this.page.locator(".discussion-close").click();
  },
);

When(
  "ボード全体に論点 {string} を追加する",
  async function (this: UsmWorld, pointText: string) {
    await this.page.locator(".discussions-open").click();
    await this.page.locator(".discussion-add textarea").fill(pointText);
    await this.page.locator(".discussion-add button").click();
    await expect(
      this.page.locator(".discussion-item.open", { hasText: pointText }),
    ).toBeVisible();
    await this.page.locator(".discussion-close").click();
  },
);

When(
  "論点 {string} を結論 {string} で解決する",
  async function (this: UsmWorld, pointText: string, resolution: string) {
    await this.page.locator(".discussions-open").click();
    const item = this.page.locator(".discussion-item.open", { hasText: pointText });
    await item.locator("button", { hasText: "解決する" }).click();
    await this.page.locator(".discussion-resolve-form textarea").fill(resolution);
    await this.page
      .locator(".discussion-resolve-buttons button", { hasText: "合意として記録" })
      .click();
    await expect(
      this.page.locator(".discussion-item.resolved", { hasText: pointText }),
    ).toBeVisible();
    await this.page.locator(".discussion-close").click();
  },
);

When(
  "論点 {string} を削除する",
  async function (this: UsmWorld, pointText: string) {
    await this.page.locator(".discussions-open").click();
    const item = this.page.locator(".discussion-item", { hasText: pointText });
    this.page.once("dialog", (d) => d.accept());
    await item.locator(".discussion-delete").click();
    await expect(item).toHaveCount(0);
    await this.page.locator(".discussion-close").click();
  },
);

Then(
  "ストーリー {string} に未解決の論点バッジ {string} が見える",
  async function (this: UsmWorld, storyText: string, count: string) {
    const badge = this.page
      .locator(".story-card", { hasText: storyText })
      .locator(".disc-badge.has-open");
    await expect(badge).toBeVisible(); // has-open は常時表示(ホバー不要)
    await expect(badge).toHaveText(`💬${count}`);
  },
);

Then(
  "ボード上に論点付箋 {string} が見える",
  async function (this: UsmWorld, pointText: string) {
    await expect(
      this.page.locator(".disc-sticky", { hasText: pointText }),
    ).toBeVisible();
  },
);

Then(
  "ボード上に論点付箋 {string} は見えない",
  async function (this: UsmWorld, pointText: string) {
    await expect(
      this.page.locator(".disc-sticky", { hasText: pointText }),
    ).toHaveCount(0);
  },
);

Then(
  "ヘッダーの論点ボタンは {string} である",
  async function (this: UsmWorld, label: string) {
    await expect(this.page.locator(".discussions-open")).toHaveText(label);
  },
);

Then(
  "論点一覧に解決済みの結論 {string} が見える",
  async function (this: UsmWorld, resolution: string) {
    await this.page.locator(".discussions-open").click();
    await expect(
      this.page.locator(".discussion-item.resolved .discussion-resolution", {
        hasText: resolution,
      }),
    ).toBeVisible();
    await this.page.locator(".discussion-close").click();
  },
);
