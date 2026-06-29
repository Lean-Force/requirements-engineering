// 集約ルート: StoryMap(1つの User Story Map 全体)。
//
// 各エンティティ(actor / story / action / activity)は自分の局所的なふるまいを持つ。
// このルートはそれらを「ナビゲートして合成」し、エンティティをまたぐ不変条件と
// 外部(UI)向けの操作の唯一の入口を提供する。すべてイミュータブル。

import { createActor, type Actor } from "./actor";
import {
  createActivity,
  actionOf,
  withNewAction,
  mapAction,
  withoutAction,
  type Activity,
} from "./activity";
import {
  withText as renameActionText,
  withNewStory,
  withRenamedStory,
  withoutStory,
  type Action,
} from "./action";

export interface StoryMap {
  actors: Actor[];
  /** ナラティブフロー(並び順が時系列) */
  activities: Activity[];
}

// ---- 初期値・正規化 ------------------------------------------------------

export function emptyStoryMap(): StoryMap {
  return { actors: [createActor("ユーザー")], activities: [] };
}

/** 外部由来(保存ファイル・モデル出力)を安全な形に正規化する純粋関数 */
export function normalizeStoryMap(map: StoryMap): StoryMap {
  const actors =
    Array.isArray(map.actors) && map.actors.length > 0
      ? map.actors
      : [createActor("ユーザー")];
  const validIds = new Set(actors.map((a) => a.id));
  const fallbackId = actors[0].id;

  const activities = (map.activities ?? []).map((activity) => ({
    id: activity.id,
    actions: (activity.actions ?? []).map((a) => ({
      id: a.id,
      actorId: validIds.has(a.actorId) ? a.actorId : fallbackId,
      text: a.text,
      stories: (a.stories ?? []).map((st) => ({ id: st.id, text: st.text })),
    })),
  }));

  return { actors, activities };
}

// ---- 問い合わせ ----------------------------------------------------------

export function findActivity(map: StoryMap, activityId: string): Activity | undefined {
  return map.activities.find((a) => a.id === activityId);
}

export function findAction(
  map: StoryMap,
  activityId: string,
  actionId: string,
): Action | undefined {
  return findActivity(map, activityId)?.actions.find((a) => a.id === actionId);
}

// 指定 Activity を関数で更新する内部ヘルパ
function mapActivity(
  map: StoryMap,
  activityId: string,
  fn: (activity: Activity) => Activity,
): StoryMap {
  return {
    ...map,
    activities: map.activities.map((a) => (a.id === activityId ? fn(a) : a)),
  };
}

// ---- 操作(UI からの唯一の変更入口。イミュータブル) ----------------------

export function addActor(map: StoryMap, name: string): StoryMap {
  return { ...map, actors: [...map.actors, createActor(name)] };
}

/** アクティビティを追加。index 省略で末尾、指定で途中(その位置)に挿入。 */
export function addActivity(map: StoryMap, index?: number): StoryMap {
  const activities = [...map.activities];
  const at =
    index === undefined
      ? activities.length
      : Math.max(0, Math.min(index, activities.length));
  activities.splice(at, 0, createActivity());
  return { ...map, activities };
}

export function addAction(
  map: StoryMap,
  activityId: string,
  actorId: string,
  text: string,
): StoryMap {
  return mapActivity(map, activityId, (act) => withNewAction(act, actorId, text));
}

/** アクティビティを削除(配下の Action / Story もカスケード削除) */
export function removeActivity(map: StoryMap, activityId: string): StoryMap {
  return { ...map, activities: map.activities.filter((a) => a.id !== activityId) };
}

export function renameAction(
  map: StoryMap,
  activityId: string,
  actionId: string,
  text: string,
): StoryMap {
  return mapActivity(map, activityId, (act) =>
    mapAction(act, actionId, (a) => renameActionText(a, text)),
  );
}

export function removeAction(
  map: StoryMap,
  activityId: string,
  actionId: string,
): StoryMap {
  return mapActivity(map, activityId, (act) => withoutAction(act, actionId));
}

// Story 操作は必ず Action を経由 → 「Story は Action 配下」が構造的に保証される
export function addStory(
  map: StoryMap,
  activityId: string,
  actionId: string,
  text: string,
): StoryMap {
  return mapActivity(map, activityId, (act) =>
    mapAction(act, actionId, (a) => withNewStory(a, text)),
  );
}

export function renameStory(
  map: StoryMap,
  activityId: string,
  actionId: string,
  storyId: string,
  text: string,
): StoryMap {
  return mapActivity(map, activityId, (act) =>
    mapAction(act, actionId, (a) => withRenamedStory(a, storyId, text)),
  );
}

export function removeStory(
  map: StoryMap,
  activityId: string,
  actionId: string,
  storyId: string,
): StoryMap {
  return mapActivity(map, activityId, (act) =>
    mapAction(act, actionId, (a) => withoutStory(a, storyId)),
  );
}

export { actionOf };
