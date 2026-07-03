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
  withActionFixed,
  withNewStory,
  withRenamedStory,
  withoutStory,
  withStoryFixed,
  type Action,
} from "./action";
import type { Story } from "./story";

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
      // 確定フラグは true のときだけ保持(JSON を汚さない)
      ...(a.fixed === true ? { fixed: true as const } : {}),
      stories: (a.stories ?? []).map((st) => ({
        id: st.id,
        text: st.text,
        // 確定フラグは true のときだけ保持(JSON を汚さない)
        ...(st.fixed === true ? { fixed: true as const } : {}),
      })),
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

/**
 * 確定(fixed)要素の保護を強制する純粋関数(サーバー側の最終防衛線)。
 * AI の出力(after)が確定済みの行動・ストーリーを変更・削除していた場合、
 * 変更前(before)の内容へ復元する。先に行動を復元してからストーリーを復元する
 * (消された行動が戻れば、その配下の確定ストーリーの復元先も戻るため)。
 */
export function enforceFixed(before: StoryMap, after: StoryMap): StoryMap {
  return enforceFixedStories(before, enforceFixedActions(before, after));
}

/**
 * 確定(fixed)行動(バックボーンの付箋)の保護。
 * 本文・アクター・確定フラグを守る(別アクティビティへの移動は許容)。
 * 消されていた場合は元のアクティビティへ配下ストーリーごと復元する。
 */
export function enforceFixedActions(before: StoryMap, after: StoryMap): StoryMap {
  const fixedActions: { action: Action; activity: Activity }[] = [];
  for (const activity of before.activities) {
    for (const action of activity.actions) {
      if (action.fixed === true) fixedActions.push({ action, activity });
    }
  }
  if (fixedActions.length === 0) return after;

  let result = after;
  for (const { action, activity } of fixedActions) {
    result = restoreFixedAction(result, action, activity);
  }
  return result;
}

function restoreFixedAction(
  map: StoryMap,
  original: Action,
  originalActivity: Activity,
): StoryMap {
  // 出力側のどこかに残っているか探す(移動は許容し、本文・アクター・フラグだけ守る)
  for (const activity of map.activities) {
    const found = activity.actions.find((a) => a.id === original.id);
    if (found) {
      return {
        ...map,
        activities: map.activities.map((act) =>
          act.id !== activity.id
            ? act
            : {
                ...act,
                actions: act.actions.map((a) =>
                  a.id !== original.id
                    ? a
                    : {
                        ...a,
                        text: original.text,
                        actorId: original.actorId,
                        fixed: true,
                      },
                ),
              },
        ),
      };
    }
  }

  // 消されていた場合: 元の activity → 無ければ activity ごと末尾に復元(配下ストーリーごと)
  const revived: Action = { ...original, stories: original.stories.map((s) => ({ ...s })) };
  const sameActivity = map.activities.find((a) => a.id === originalActivity.id);
  if (sameActivity) {
    return {
      ...map,
      activities: map.activities.map((act) =>
        act.id !== originalActivity.id
          ? act
          : { ...act, actions: [...act.actions, revived] },
      ),
    };
  }
  return {
    ...map,
    activities: [...map.activities, { ...originalActivity, actions: [revived] }],
  };
}

/**
 * 確定(fixed)ストーリーの保護を強制する純粋関数。
 * AI の出力(after)が確定ストーリーを変更・削除していた場合、変更前(before)の
 * 内容へ復元する。プロンプトでの指示に加えた、サーバー側の最終防衛線。
 *
 * 復元先は「同じ action」→ 無ければ「同じ activity に元の action を再作成」→
 * それも無ければ「元の activity ごと末尾に再作成」の順で探す。
 */
export function enforceFixedStories(before: StoryMap, after: StoryMap): StoryMap {
  // before 側の確定ストーリーと、その居場所を控える
  const fixedStories: {
    story: Story;
    activity: Activity;
    action: Action;
  }[] = [];
  for (const activity of before.activities) {
    for (const action of activity.actions) {
      for (const story of action.stories) {
        if (story.fixed === true) fixedStories.push({ story, activity, action });
      }
    }
  }
  if (fixedStories.length === 0) return after;

  let result = after;
  for (const { story, activity, action } of fixedStories) {
    result = restoreFixedStory(result, story, activity, action);
  }
  return result;
}

function restoreFixedStory(
  map: StoryMap,
  original: Story,
  originalActivity: Activity,
  originalAction: Action,
): StoryMap {
  // 出力側のどこかに残っているか探す(移動は許容し、内容と確定フラグだけ守る)
  for (const activity of map.activities) {
    for (const action of activity.actions) {
      if (action.stories.some((s) => s.id === original.id)) {
        return {
          ...map,
          activities: map.activities.map((act) =>
            act.id !== activity.id
              ? act
              : {
                  ...act,
                  actions: act.actions.map((a) =>
                    a.id !== action.id
                      ? a
                      : {
                          ...a,
                          stories: a.stories.map((s) =>
                            s.id === original.id ? { ...original } : s,
                          ),
                        },
                  ),
                },
          ),
        };
      }
    }
  }

  // 消されていた場合: 元の action → 元の activity → マップ末尾の順で復元する
  const targetActivity = map.activities.find((a) =>
    a.actions.some((ac) => ac.id === originalAction.id),
  );
  if (targetActivity) {
    return {
      ...map,
      activities: map.activities.map((act) =>
        act.id !== targetActivity.id
          ? act
          : {
              ...act,
              actions: act.actions.map((a) =>
                a.id !== originalAction.id
                  ? a
                  : { ...a, stories: [...a.stories, { ...original }] },
              ),
            },
      ),
    };
  }

  const revivedAction: Action = { ...originalAction, stories: [{ ...original }] };
  const sameActivity = map.activities.find((a) => a.id === originalActivity.id);
  if (sameActivity) {
    return {
      ...map,
      activities: map.activities.map((act) =>
        act.id !== originalActivity.id
          ? act
          : { ...act, actions: [...act.actions, revivedAction] },
      ),
    };
  }

  return {
    ...map,
    activities: [
      ...map.activities,
      { ...originalActivity, actions: [revivedAction] },
    ],
  };
}

export { actionOf };
