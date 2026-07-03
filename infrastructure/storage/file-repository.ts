import { promises as fs } from "fs";
import path from "path";
import type { BoardSession } from "@/contracts";
import type { StoryMapRepository } from "./repository";
import { emptySession, normalizeSession } from "./session";

// セッション(マップ・会話・版履歴)をボードのワークスペース内の JSON ファイルに読み書きする。
// テスト時は DATA_DIR でデータ全体を隔離できる(本番データを汚さない)。
export class FileStoryMapRepository implements StoryMapRepository {
  private readonly file: string;

  constructor(file: string) {
    this.file = path.resolve(file);
  }

  async loadSession(): Promise<BoardSession> {
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      // 旧フォーマット(素の StoryMap)も normalizeSession が吸収する
      return normalizeSession(JSON.parse(raw));
    } catch {
      // ファイルがまだ無ければ空セッションを返す
      return emptySession();
    }
  }

  async saveSession(session: BoardSession): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(session, null, 2), "utf-8");
  }
}
