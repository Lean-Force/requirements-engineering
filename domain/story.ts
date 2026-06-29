// エンティティ: Story(ユーザーストーリー「◯◯は〜したい」)。必ず Action にぶら下がる。
import { genId } from "./id";

export interface Story {
  id: string;
  text: string;
}

export function createStory(text: string): Story {
  return { id: genId("story"), text };
}

/** 本文を差し替えた新しい Story を返す(イミュータブル) */
export function withText(story: Story, text: string): Story {
  return { ...story, text };
}
