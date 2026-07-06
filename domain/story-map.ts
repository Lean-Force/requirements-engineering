// 集約ルート: StoryMap(1つの User Story Map 全体)。
//
// 各エンティティ(actor / story / action / activity)は自分の局所的なふるまいを持つ。
// このルートはそれらを「ナビゲートして合成」し、エンティティをまたぐ不変条件と
// 外部(UI)向けの操作の唯一の入口を提供する。すべてイミュータブル。

import { createActor, type Actor } from "./actor";
import {
  createActivity,
  withNewAction,
  mapAction,
  withoutAction,
  type Activity,
} from "./activity";
import {
  withText as renameActionText,
  withActionFixed,
  withNewStory,
  withRenamedStory,
  withoutStory,
  withStoryFixed,
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

  const activities = (map.activities ?? []).map((activity) => {
    const actions = (activity.actions ?? []).map((a) => ({
      id: a.id,
      actorId: validIds.has(a.actorId) ? a.actorId : fallbackId,
      text: a.text,
      // 確定フラグは true のときだけ保持(JSON を汚さない)
      ...(a.fixed === true ? { fixed: true as const } : {}),
      stories: (a.stories ?? []).map((st) => ({
        id: st.id,
        text: st.text,
        // 確定フラグは true のときだけ保持(JSON を汚さない)
        ...(st.fixed === true ? { fixed: true as const } : {}),
      })),
    }));
    // ストーリー列の表示順: 実在する story id だけを重複なしで保持
    const validStoryIds = new Set(actions.flatMap((a) => a.stories.map((s) => s.id)));
    const storyOrder = (activity.storyOrder ?? []).filter(
      (id, i, arr) =>
        typeof id === "string" && validStoryIds.has(id) && arr.indexOf(id) === i,
    );
    return {
      id: activity.id,
      actions,
      // 随時フラグは true のときだけ保持(JSON を汚さない)
      ...(activity.standalone === true ? { standalone: true as const } : {}),
      ...(storyOrder.length > 0 ? { storyOrder } : {}),
    };
  });

  // 連続した流れ(時系列)を先に、随時・例外の場面を末尾にまとめる
  // (それぞれの中では元の並び順を保つ。タイムラインの意味を決定的に守る)
  const flow = activities.filter((a) => a.standalone !== true);
  const standalone = activities.filter((a) => a.standalone === true);
  return { actors, activities: [...flow, ...standalone] };
}

/** 場面を「随時(時系列外)」⇄「連続の流れ」に切り替える(正規化で並びも追従) */
export function setActivityStandalone(
  map: StoryMap,
  activityId: string,
  standalone: boolean,
): StoryMap {
  return normalizeStoryMap({
    ...map,
    activities: map.activities.map((a) =>
      a.id === activityId ? { ...a, standalone } : a,
    ),
  });
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

// 指定 Activity を関数で更新するヘルパ(兄弟モジュール ordering からも使う)
export function mapActivity(
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

/** アクターを削除。各 activity からそのアクターの action(配下の story も)をカスケード削除。 */
export function removeActor(map: StoryMap, actorId: string): StoryMap {
  return {
    ...map,
    actors: map.actors.filter((a) => a.id !== actorId),
    activities: map.activities.map((activity) => ({
      ...activity,
      actions: activity.actions.filter((a) => a.actorId !== actorId),
    })),
  };
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

/** ストーリーの確定(fix)状態を切り替える */
export function setStoryFixed(
  map: StoryMap,
  activityId: string,
  actionId: string,
  storyId: string,
  fixed: boolean,
): StoryMap {
  return mapActivity(map, activityId, (act) =>
    mapAction(act, actionId, (a) => withStoryFixed(a, storyId, fixed)),
  );
}

/** 行動(バックボーンの付箋)の確定(fix)状態を切り替える */
export function setActionFixed(
  map: StoryMap,
  activityId: string,
  actionId: string,
  fixed: boolean,
): StoryMap {
  return mapActivity(map, activityId, (act) =>
    mapAction(act, actionId, (a) => withActionFixed(a, fixed)),
  );
}
