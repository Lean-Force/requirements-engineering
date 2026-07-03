import { setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber";
import type { BrowserContext, Page } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

export const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

// E2E はテスト専用のデータディレクトリに隔離する(本番データ data/ は触らない)。
// 対象 dev サーバーは DATA_DIR=data/e2e-data で起動しておくこと。
export const E2E_DATA_DIR = path.join(process.cwd(), "data", "e2e-data");

/** E2E 用の World。シナリオごとに 1 ブラウザコンテキスト / ページ / ボードを持つ。 */
export class UsmWorld extends World {
  context!: BrowserContext;
  page!: Page;
  /** シナリオ用に作成されたボードの id(フックで採番) */
  boardId!: string;
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

  /** セッション(マップ+会話+版)をボードの保存ファイルに直接書き込む。
   *  LLM を呼ばずに「保存済み状態」を再現してテストするために使う。
   *  サーバーは force-dynamic で都度ファイルを読むので、書いてからページを開けば反映される。 */
  async seedSession(session: unknown) {
    const file = path.join(E2E_DATA_DIR, "workspaces", this.boardId, "session.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(session), "utf-8");
  }
}

setWorldConstructor(UsmWorld);
