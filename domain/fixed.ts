// 確定(fixed)要素の保護ポリシー。
//
// AI の出力が「チームが合意して確定した」行動・ストーリーを壊していた場合に、
// 変更前の内容へ復元する純粋関数群。プロンプトでの指示に加えた最終防衛線。

import type { Action } from "./action";
import type { Activity } from "./activity";
import type { Story } from "./story";
import type { StoryMap } from "./story-map";

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

