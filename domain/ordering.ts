// ストーリーの並び・移動のポリシー。
//
// - reorderStoryInColumn: 列(ステップ)内の表示順だけを変える(所属・色は不変)
// - moveStory: 行動間の付け替え(現状 UI からは未使用。AI 指示や将来の操作用)
// - preserveStoryOrder: AI 出力へ表示順を引き継ぐ(storyOrder は AI のスキーマ外)

import { orderedStories } from "./activity";
import { findAction, findActivity, mapActivity, type StoryMap } from "./story-map";

/**
 * ストーリー列(ステップ)内での表示順の並び替え。所属(行動)と色は変えない。
 * toIndex は列の表示順(orderedStories の並び)での挿入位置。
 */
export function reorderStoryInColumn(
  map: StoryMap,
  activityId: string,
  storyId: string,
  toIndex: number,
): StoryMap {
  const activity = findActivity(map, activityId);
  if (!activity) return map;
  const order = orderedStories(activity).map((p) => p.story.id);
  const from = order.indexOf(storyId);
  if (from < 0) return map;
  const insert = from < toIndex ? toIndex - 1 : toIndex;
  order.splice(from, 1);
  order.splice(Math.max(0, Math.min(insert, order.length)), 0, storyId);
  return mapActivity(map, activityId, (act) => ({ ...act, storyOrder: order }));
}

/**
 * AI の出力(after)にストーリー列の表示順を引き継ぐ。
 * storyOrder は AI のスキーマに含めないため、チャットの度にここで復元する
 * (存在しなくなった id は normalizeStoryMap が掃除する)。
 */
export function preserveStoryOrder(before: StoryMap, after: StoryMap): StoryMap {
  const orders = new Map(
    before.activities
      .filter((a) => (a.storyOrder ?? []).length > 0)
      .map((a) => [a.id, a.storyOrder as string[]]),
  );
  if (orders.size === 0) return after;
  return {
    ...after,
    activities: after.activities.map((a) => {
      const order = orders.get(a.id);
      return order ? { ...a, storyOrder: order } : a;
    }),
  };
}

/**
 * ストーリーを移動する(同じ行動内の並び替え / 別の行動・ステップへの付け替え)。
 * toIndex は「移動先の行動の stories 配列に挿入する位置」。
 * 対象が見つからない場合は何もしない。
 */
export function moveStory(
  map: StoryMap,
  from: { activityId: string; actionId: string; storyId: string },
  to: { activityId: string; actionId: string; index: number },
): StoryMap {
  const source = findAction(map, from.activityId, from.actionId);
  const story = source?.stories.find((s) => s.id === from.storyId);
  if (!source || !story) return map;
  if (!findAction(map, to.activityId, to.actionId)) return map;

  // 同一行動内の並び替えは、取り除いた分だけ挿入位置を詰める
  const sameAction = from.actionId === to.actionId && from.activityId === to.activityId;
  const removeIndex = source.stories.findIndex((s) => s.id === from.storyId);
  const insertIndex =
    sameAction && removeIndex < to.index ? to.index - 1 : to.index;

  // 取り除く
  const removed: StoryMap = {
    ...map,
    activities: map.activities.map((act) =>
      act.id !== from.activityId
        ? act
        : {
            ...act,
            actions: act.actions.map((a) =>
              a.id !== from.actionId
                ? a
                : { ...a, stories: a.stories.filter((s) => s.id !== from.storyId) },
            ),
          },
    ),
  };

  // 挿入する
  return {
    ...removed,
    activities: removed.activities.map((act) =>
      act.id !== to.activityId
        ? act
        : {
            ...act,
            actions: act.actions.map((a) => {
              if (a.id !== to.actionId) return a;
              const stories = [...a.stories];
              const at = Math.max(0, Math.min(insertIndex, stories.length));
              stories.splice(at, 0, { ...story });
              return { ...a, stories };
            }),
          },
    ),
  };
}
