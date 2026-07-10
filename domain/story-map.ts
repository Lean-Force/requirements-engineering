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

/** リリースの定義(名前だけ。番号は配列の index) */
export interface ReleaseDef {
  name: string;
}

export interface StoryMap {
  actors: Actor[];
  /** ナラティブフロー(並び順が時系列) */
  activities: Activity[];
  /**
   * リリースの定義(名前リスト)。index 0 = MVP/リリース1、1 = リリース2 …
   * 省略時は [{ name: "MVP" }] が既定。
   */
  releases?: ReleaseDef[];
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
        // リリース番号: undefined = 未分類(どのリリースにも入っていない)。
        // 0 = MVP(明示的に入れた)。省略と 0 は意味が違う
        ...(typeof st.release === "number"
          ? { release: Math.floor(st.release) }
          : {}),
      })),
    }));
    // ストーリー列の表示順: 実在する story id だけを重複なしで保持
    const validStoryIds = new Set(actions.flatMap((a) => a.stories.map((s) => s.id)));
    const storyOrder = (activity.storyOrder ?? []).filter(
      (id, i, arr) =>
        typeof id === "string" && validStoryIds.has(id) && arr.indexOf(id) === i,
    );
    const flowName =
      typeof activity.flowName === "string" ? activity.flowName.trim() : "";
    return {
      id: activity.id,
      actions,
      // 随時フラグは true のときだけ保持(JSON を汚さない)。随時に流れ名は付けない
      ...(activity.standalone === true ? { standalone: true as const } : {}),
      ...(flowName && activity.standalone !== true ? { flowName } : {}),
      ...(storyOrder.length > 0 ? { storyOrder } : {}),
    };
  });

  // 連続した流れ(時系列)を先に、随時・例外のステップを末尾にまとめる。
  // さらに連続側はアクティビティ(flowName)ごとに隣接へクラスタ化する
  // (流れの初出順・流れ内の元順を保つ。名前なしのステップは単独の塊として扱う)。
  const flow = activities.filter((a) => a.standalone !== true);
  const standalone = activities.filter((a) => a.standalone === true);
  const order: string[] = [];
  const buckets = new Map<string, typeof flow>();
  flow.forEach((a, i) => {
    const key = a.flowName ?? `__solo_${i}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(a);
  });
  const clustered = order.flatMap((k) => buckets.get(k)!);
  // リリース定義: 空や未指定は省略(既定 = MVP のみ)
  const releases = Array.isArray(map.releases) && map.releases.length > 0
    ? map.releases.map((r) => ({ name: typeof r.name === "string" ? r.name.trim() || "MVP" : "MVP" }))
    : undefined;
  return { actors, activities: [...clustered, ...standalone], ...(releases ? { releases } : {}) };
}

/** 指定のステップたちにアクティビティの名前を付ける(空文字で外す)。正規化で隣接が保証される */
export function setFlowName(
  map: StoryMap,
  activityIds: string[],
  flowName: string,
): StoryMap {
  const ids = new Set(activityIds);
  return normalizeStoryMap({
    ...map,
    activities: map.activities.map((a) =>
      ids.has(a.id) ? { ...a, flowName: flowName.trim() || undefined } : a,
    ),
  });
}

/** ステップを「随時(時系列外)」⇄「連続の流れ」に切り替える(正規化で並びも追従) */
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

/** ステップを追加。index 省略で末尾、指定で途中(その位置)に挿入。 */
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

/** ステップを削除(配下の Action / Story もカスケード削除) */
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

/** ストーリーのリリースを変更する(負の値で未分類に戻す) */
export function setStoryRelease(
  map: StoryMap,
  storyId: string,
  release: number,
): StoryMap {
  return normalizeStoryMap({
    ...map,
    activities: map.activities.map((act) => ({
      ...act,
      actions: act.actions.map((a) => ({
        ...a,
        stories: a.stories.map((st) =>
          st.id === storyId
            ? release < 0
              ? { ...st, release: undefined }
              : { ...st, release }
            : st,
        ),
      })),
    })),
  });
}

/** リリース定義を更新する(名前の変更・追加・削除) */
export function setReleases(
  map: StoryMap,
  releases: ReleaseDef[],
): StoryMap {
  return normalizeStoryMap({ ...map, releases });
}
