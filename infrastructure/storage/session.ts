import { emptyStoryMap, normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type { BoardSession, ChatMessage, StoryMapVersion } from "@/contracts";

// 初期セッション(マップは初期マップ、会話・版は空)。
export function emptySession(): BoardSession {
  return { storyMap: emptyStoryMap(), messages: [], versions: [] };
}

// 保存データを安全な BoardSession に正規化する。
// 新形式(BoardSession)と旧形式(素の StoryMap だけを保存していた時代)の両方を受ける。
export function normalizeSession(raw: unknown): BoardSession {
  if (raw && typeof raw === "object" && "storyMap" in (raw as object)) {
    const r = raw as Partial<BoardSession>;
    return {
      storyMap: normalizeStoryMap((r.storyMap ?? {}) as StoryMap),
      messages: Array.isArray(r.messages) ? (r.messages as ChatMessage[]) : [],
      versions: Array.isArray(r.versions) ? (r.versions as StoryMapVersion[]) : [],
    };
  }
  // 旧形式: 素の StoryMap(actors/activities を直接持つ)
  if (
    raw &&
    typeof raw === "object" &&
    ("actors" in (raw as object) || "activities" in (raw as object))
  ) {
    return { storyMap: normalizeStoryMap(raw as StoryMap), messages: [], versions: [] };
  }
  return emptySession();
}
