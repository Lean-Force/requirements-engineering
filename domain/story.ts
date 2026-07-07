// エンティティ: Story(ユーザーストーリー「◯◯は〜したい」)。必ず Action にぶら下がる。
import { genId } from "./id";

export interface Story {
  id: string;
  text: string;
  /** 確定(チーム合意済み)。true のストーリーは AI が変更・削除できない */
  fixed?: boolean;
  /**
   * リリース番号(0 = MVP/リリース1、1 = リリース2 …)。
   * 未指定は 0(MVP)扱い。マップを横に切って「まず何を作るか」を決める。
   */
  release?: number;
}

export function createStory(text: string): Story {
  return { id: genId("story"), text };
}

/** 本文を差し替えた新しい Story を返す(イミュータブル) */
export function withText(story: Story, text: string): Story {
  return { ...story, text };
}

/** 確定状態を切り替えた新しい Story を返す(イミュータブル) */
export function withFixed(story: Story, fixed: boolean): Story {
  const { fixed: _omit, ...rest } = story;
  void _omit;
  return fixed ? { ...rest, fixed: true } : rest;
}
