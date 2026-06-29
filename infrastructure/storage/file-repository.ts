import { promises as fs } from "fs";
import path from "path";
import type { BoardSession } from "@/contracts";
import type { StoryMapRepository } from "./repository";
import { emptySession, normalizeSession } from "./session";

// ローカル開発 / E2E 用の実装。セッション全体を 1 つの JSON ファイルに読み書きする。
// テスト時は STORYMAP_FILE で別ファイルに隔離できる(本番サンプル data/storymap.json を汚さない)。
export class FileStoryMapRepository implements StoryMapRepository {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file
      ? path.resolve(file)
      : path.join(process.cwd(), "data", "storymap.json");
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
