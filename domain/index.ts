// ドメイン層の公開窓口。外側(UI / infrastructure / app)は常にここから import する。
//
// エンティティ単位(actor / story / action / activity)で定義し、
// 集約ルート(story-map)が全体の操作と不変条件の入口になる。
// 各エンティティの「局所ふるまい(with〜)」は集約の実装詳細なので公開しない。

// エンティティの型
export type { Actor } from "./actor";
export type { Story } from "./story";
export type { Action } from "./action";
export type { Activity } from "./activity";
export type { StoryMap } from "./story-map";

// ファクトリ
export { createActor } from "./actor";
export { createStory } from "./story";
export { createAction } from "./action";
export { createActivity } from "./activity";

// 問い合わせ
export { actionOf } from "./activity";
export { findActivity, findAction } from "./story-map";

// 集約への操作(UI からの唯一の変更入口)
export {
  emptyStoryMap,
  normalizeStoryMap,
  addActor,
  removeActor,
  addActivity,
  removeActivity,
  addAction,
  renameAction,
  removeAction,
  addStory,
  renameStory,
  removeStory,
  setStoryFixed,
  enforceFixedStories,
} from "./story-map";
