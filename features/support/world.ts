import { setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber";
import type { BrowserContext, Page } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

export const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

// E2E はテスト専用のデータファイルに隔離する(本番サンプル data/storymap.json は触らない)。
// 対象 dev サーバーは STORYMAP_FILE=data/e2e-storymap.json で起動しておくこと。
export const E2E_DATA_FILE = path.join(process.cwd(), "data", "e2e-storymap.json");

/** E2E 用の World。シナリオごとに 1 ブラウザコンテキスト / ページを持つ。 */
export class UsmWorld extends World {
  context!: BrowserContext;
  page!: Page;
  /** キャンバス操作テストで、移動前の位置を控えるための一時値 */
  recordedX?: number;

  constructor(opts: IWorldOptions) {
    super(opts);
  }

  /** 指定アクター名の行(lane)を返す */
  lane(actorName: string) {
    return this.page
      .locator(".lane")
      .filter({ has: this.page.locator(".lane-label", { hasText: actorName }) });
  }

  /** セッション(マップ+会話+版)を保存ファイルに直接書き込む。
   *  LLM を呼ばずに「保存済み状態」を再現してテストするために使う。
   *  サーバーは force-dynamic で都度ファイルを読むので、書いてからページを開けば反映される。 */
  async seedSession(session: unknown) {
    await fs.mkdir(path.dirname(E2E_DATA_FILE), { recursive: true });
    await fs.writeFile(E2E_DATA_FILE, JSON.stringify(session), "utf-8");
  }
}

setWorldConstructor(UsmWorld);
