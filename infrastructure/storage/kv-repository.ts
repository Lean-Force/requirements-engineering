import type { BoardSession } from "@/contracts";
import type { StoryMapRepository } from "./repository";
import { emptySession, normalizeSession } from "./session";

// Cloudflare Workers KV の最小I/F。
// @cloudflare/workers-types への依存を避けるため、必要なメソッドだけ構造的に定義する。
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

// Cloudflare 本番用の実装。セッション全体(JSON)を単一キーに保存する。
// Workers にはファイルシステムが無いため、保存先を KV に置く。
export class KvStoryMapRepository implements StoryMapRepository {
  private readonly key = "session";
  // 旧デプロイで素の StoryMap を保存していたキー(移行のため読むだけ)。
  private readonly legacyKey = "storymap";

  constructor(private readonly kv: KvLike) {}

  async loadSession(): Promise<BoardSession> {
    const raw = await this.kv.get(this.key);
    if (raw) return normalizeSession(safeParse(raw));
    // 旧キーからの移行(初回だけ拾い上げる。書き戻しは次回 saveSession で起きる)
    const legacy = await this.kv.get(this.legacyKey);
    if (legacy) return normalizeSession(safeParse(legacy));
    return emptySession();
  }

  async saveSession(session: BoardSession): Promise<void> {
    await this.kv.put(this.key, JSON.stringify(session));
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
