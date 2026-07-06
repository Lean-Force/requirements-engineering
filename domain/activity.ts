// エンティティ: Activity(ナラティブフロー上の1単位)。複数アクターの Action を束ねる。
import { genId } from "./id";
import { createAction, type Action } from "./action";
import type { Story } from "./story";

export interface Activity {
  id: string;
  /** この Activity に参加するアクターの行動(複数アクター可) */
  actions: Action[];
  /**
   * 時系列(ナラティブフロー)に属さない場面 = 随時・例外・定期。
   * true の場面は正規化でバックボーン末尾へまとめられ、UI では区切りの右に
   * 「随時」として表示される(タイムラインの意味を守る)。
   */
  standalone?: boolean;
  /**
   * ストーリー列の表示順(story id の並び)。D&D の並び替えで更新される。
   * 所属(どの行動の配下か)は変えず、見た目の上下だけを自由にするための
   * サーバー管理フィールド。AI の入出力スキーマには含めない。
   * 載っていないストーリーは行動のグループ順で後ろに続く。
   */
  storyOrder?: string[];
}

export function createActivity(): Activity {
  return { id: genId("activity"), actions: [] };
}

/** ある Activity における、指定アクターの Action(無ければ undefined) */
export function actionOf(activity: Activity, actorId: string): Action | undefined {
  return activity.actions.find((a) => a.actorId === actorId);
}

/**
 * ストーリー列の表示順を解決する: storyOrder に載っているものを先に、
 * 残りは行動のグループ順で。各ストーリーは所属 Action とペアで返す(色・編集用)。
 */
export function orderedStories(
  activity: Activity,
): { story: Story; action: Action }[] {
  const byId = new Map<string, { story: Story; action: Action }>();
  for (const action of activity.actions) {
    for (const story of action.stories) byId.set(story.id, { story, action });
  }
  const pairs: { story: Story; action: Action }[] = [];
  const seen = new Set<string>();
  for (const id of activity.storyOrder ?? []) {
    const hit = byId.get(id);
    if (hit && !seen.has(id)) {
      pairs.push(hit);
      seen.add(id);
    }
  }
  for (const action of activity.actions) {
    for (const story of action.stories) {
      if (!seen.has(story.id)) {
        pairs.push({ story, action });
        seen.add(story.id);
      }
    }
  }
  return pairs;
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
