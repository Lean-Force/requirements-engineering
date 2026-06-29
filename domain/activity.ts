// エンティティ: Activity(ナラティブフロー上の1単位)。複数アクターの Action を束ねる。
import { genId } from "./id";
import { createAction, type Action } from "./action";

export interface Activity {
  id: string;
  /** この Activity に参加するアクターの行動(複数アクター可) */
  actions: Action[];
}

export function createActivity(): Activity {
  return { id: genId("activity"), actions: [] };
}

/** ある Activity における、指定アクターの Action(無ければ undefined) */
export function actionOf(activity: Activity, actorId: string): Action | undefined {
  return activity.actions.find((a) => a.actorId === actorId);
}

// --- 局所的なふるまい(イミュータブル) ---

/** Actor の行動を追加。同一アクターの行動が既にあれば追加しない(各アクター最大1の不変条件) */
export function withNewAction(activity: Activity, actorId: string, text: string): Activity {
  if (actionOf(activity, actorId)) return activity;
  return { ...activity, actions: [...activity.actions, createAction(actorId, text)] };
}

/** 指定 Action を関数で更新した新しい Activity を返す */
export function mapAction(
  activity: Activity,
  actionId: string,
  fn: (a: Action) => Action,
): Activity {
  return {
    ...activity,
    actions: activity.actions.map((a) => (a.id === actionId ? fn(a) : a)),
  };
}

export function withoutAction(activity: Activity, actionId: string): Activity {
  return { ...activity, actions: activity.actions.filter((a) => a.id !== actionId) };
}
