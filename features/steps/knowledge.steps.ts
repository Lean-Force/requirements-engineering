// ドメイン知識パネルの E2E ステップ。
// シードは LLM 後段の本物の適用関数で行う(モック・フェイクなし)。
// cucumber プロセスからサーバーと同じ DATA_DIR(data/e2e-data)へ直接書き込み、
// サーバーはリクエストごとにファイルを読むため次の GET で反映される。
import { Given, When, Then } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { UsmWorld, BASE_URL, E2E_DATA_DIR } from "../support/world";

/** サーバーと同じデータディレクトリを向けて、本物の適用関数を呼ぶ */
async function withServerData<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = E2E_DATA_DIR;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
  }
}

Given(
  "知識 {string} 内容 {string} の資料 {string} がある",
  async function (this: UsmWorld, title: string, content: string, fileName: string) {
    await withServerData(async () => {
      const { applySource } = await import("../../infrastructure/context");
      await applySource(this.boardId, fileName, Buffer.from("原文"), [
        { category: "flows", title, content, common: false },
      ]);
    });
  },
);

Given(
  "資料 {string} に矛盾 {string} が記録されている",
  async function (this: UsmWorld, fileName: string, topic: string) {
    await withServerData(async () => {
      const { getKnowledgeState, recordConflicts } = await import(
        "../../infrastructure/context"
      );
      const state = await getKnowledgeState(this.boardId);
      const source = state.sources.find((s) => s.fileName === fileName)!;
      await recordConflicts(this.boardId, source.id, fileName, [
        {
          topic,
          newClaim: "2億円超は役員承認",
          existingSource: fileName,
          existingClaim: "1,000万円超は部長承認",
        },
      ]);
    });
  },
);

Given(
  "資料 {string} に新業務 {string} の提案が記録されている",
  async function (this: UsmWorld, fileName: string, name: string) {
    await withServerData(async () => {
      const { getKnowledgeState, recordBoardProposal } = await import(
        "../../infrastructure/context"
      );
      const state = await getKnowledgeState(this.boardId);
      const source = state.sources.find((s) => s.fileName === fileName)!;
      await recordBoardProposal(this.boardId, source.id, fileName, {
        isNewBusiness: true,
        name,
        reason: "独立した業務のフローが記載されている",
      });
    });
  },
);

When("ボードを開き知識パネルを開く", async function (this: UsmWorld) {
  await this.page.goto(`${BASE_URL}/boards/${this.boardId}`);
  await expect(this.page.locator(".backbone")).toBeVisible();
  await this.page.locator(".context-open").click();
  await expect(this.page.locator(".context-panel")).toBeVisible();
});

Then("資料 {string} が一覧に見える", async function (this: UsmWorld, fileName: string) {
  await expect(this.page.locator(".context-name", { hasText: fileName })).toBeVisible();
});

Then(
  "カテゴリ {string} の件数は {int} である",
  async function (this: UsmWorld, label: string, count: number) {
    const category = this.page.locator(".kb-category", { hasText: label });
    await expect(category.locator(".kb-count")).toHaveText(String(count));
  },
);

Then("コンテキストサイズのメーターが表示される", async function (this: UsmWorld) {
  await expect(this.page.locator(".context-size")).toContainText("AI へのコンテキスト");
  await expect(this.page.locator(".context-size")).toContainText("トークン");
});

When(
  "資料 {string} のエントリ一覧を開く",
  async function (this: UsmWorld, fileName: string) {
    await this.page.locator(".context-name", { hasText: fileName }).click();
    await expect(this.page.locator(".entries-body")).toBeVisible();
  },
);

When(
  "エントリ {string} を編集して本文を {string} にする",
  async function (this: UsmWorld, title: string, content: string) {
    const item = this.page
      .locator(".entry-item")
      .filter({ has: this.page.locator(".entry-title", { hasText: title }) });
    await item.locator(".entry-edit").click();
    await item.locator(".entry-editor textarea").first().fill(content);
    await item.locator(".entry-save").click();
    // 保存でエディタが閉じるのを待つ
    await expect(item.locator(".entry-editor")).toBeHidden();
  },
);

Then("エントリ一覧に {string} のバッジが見える", async function (this: UsmWorld, badge: string) {
  await expect(this.page.locator(".entry-badge", { hasText: badge })).toBeVisible();
});

Then("エントリ本文に {string} が見える", async function (this: UsmWorld, text: string) {
  await expect(this.page.locator(".entry-content", { hasText: text })).toBeVisible();
});

When("エントリ {string} を削除する", async function (this: UsmWorld, title: string) {
  this.page.once("dialog", (d) => d.accept());
  const item = this.page
    .locator(".entry-item")
    .filter({ has: this.page.locator(".entry-title", { hasText: title }) });
  await item.locator(".entry-delete").click();
  await expect(item).toBeHidden();
});

Then(
  "資料 {string} の抽出件数は {int} と表示される",
  async function (this: UsmWorld, fileName: string, count: number) {
    const item = this.page
      .locator(".context-item")
      .filter({ has: this.page.locator(".context-name", { hasText: fileName }) });
    await expect(item.locator(".context-meta")).toContainText(`${count} 件の知識を抽出`);
  },
);

Then("矛盾カード {string} が見える", async function (this: UsmWorld, topic: string) {
  await expect(this.page.locator(".conflict-item", { hasText: topic })).toBeVisible();
});

When("その矛盾を解決済みにする", async function (this: UsmWorld) {
  await this.page.locator(".conflict-dismiss").click();
});

Then("矛盾カードは消える", async function (this: UsmWorld) {
  await expect(this.page.locator(".conflict-item")).toHaveCount(0);
});

Then("提案カード {string} が見える", async function (this: UsmWorld, name: string) {
  await expect(this.page.locator(".proposal-item", { hasText: name })).toBeVisible();
});

When("その提案を却下する", async function (this: UsmWorld) {
  await this.page.locator(".proposal-dismiss").click();
});

Then("提案カードは消える", async function (this: UsmWorld) {
  await expect(this.page.locator(".proposal-item")).toHaveCount(0);
});
