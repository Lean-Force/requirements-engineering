import {
  BeforeAll,
  AfterAll,
  Before,
  After,
  setDefaultTimeout,
} from "@cucumber/cucumber";
import { chromium, type Browser } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";
import { UsmWorld, BASE_URL } from "./world";

setDefaultTimeout(60_000);

// E2E はテスト専用のデータディレクトリに隔離する(本番データ data/ は触らない)。
// 対象の dev サーバーは DATA_DIR=data/e2e-data で起動しておくこと。
const E2E_DATA_DIR = path.join(process.cwd(), "data", "e2e-data");
// 各シナリオの最終状態を撮影して保存(UI 崩れの目視/視覚回帰の確認用)。
// 撮影はテストハーネスの関心事なので Gherkin には書かず、ここ(フック)で行う。
const SHOT_DIR = path.join(process.cwd(), "e2e-screenshots");

let browser: Browser;

BeforeAll(async () => {
  browser = await chromium.launch();
});

AfterAll(async () => {
  await browser?.close();
  // 後片付け(隔離データディレクトリを削除)
  await fs.rm(E2E_DATA_DIR, { recursive: true, force: true });
});

Before(async function (this: UsmWorld, scenario) {
  // シナリオごとに新しいボードを作る(= 空のマップから開始、シナリオ間で独立)
  const res = await fetch(`${BASE_URL}/api/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `e2e: ${scenario.pickle.name}` }),
  });
  if (!res.ok) {
    throw new Error(`E2E 用ボードの作成に失敗しました(${res.status})`);
  }
  this.boardId = ((await res.json()) as { id: string }).id;

  this.context = await browser.newContext();
  this.page = await this.context.newPage();
});

After(async function (this: UsmWorld, scenario) {
  // 全シナリオの最終状態を撮影(成功/失敗とも)。レポート添付 + ファイル保存。
  if (this.page) {
    try {
      // ホバー専用の追加ボタンを消すためマウスを退避し、静止状態を撮る
      await this.page.mouse.move(0, 0);
      await this.page.waitForTimeout(150);
      await fs.mkdir(SHOT_DIR, { recursive: true });
      const name = scenario.pickle.name.replace(/[^\p{L}\p{N}-]+/gu, "_");
      const img = await this.page.screenshot({
        path: path.join(SHOT_DIR, `${name}.png`),
        fullPage: true,
      });
      this.attach(img, "image/png");
    } catch {
      // 撮影失敗はテスト結果に影響させない
    }
  }
  await this.context?.close();
});
