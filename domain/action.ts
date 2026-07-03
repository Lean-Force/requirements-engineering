// エンティティ: Action(行動 = あるアクターの、ある Activity での行動)。
// Story は必ずこの Action の下に保持される。
import { genId } from "./id";
import { createStory, withFixed, withText as renameStory, type Story } from "./story";

export interface Action {
  id: string;
  /** どのアクターの行動か(Actor.id) */
  actorId: string;
  text: string;
  /** この行動にぶら下がるストーリー(時系列に左→右) */
  stories: Story[];
}

export function createAction(actorId: string, text: string): Action {
  return { id: genId("action"), actorId, text, stories: [] };
}

// --- 局所的なふるまい(この Action 自身の更新。すべてイミュータブル) ---

export function withText(action: Action, text: string): Action {
  return { ...action, text };
}

export function withNewStory(action: Action, text: string): Action {
  return { ...action, stories: [...action.stories, createStory(text)] };
}

export function withRenamedStory(action: Action, storyId: string, text: string): Action {
  return {
    ...action,
    stories: action.stories.map((s) => (s.id === storyId ? renameStory(s, text) : s)),
  };
}

export function withoutStory(action: Action, storyId: string): Action {
  return { ...action, stories: action.stories.filter((s) => s.id !== storyId) };
}

export function withStoryFixed(action: Action, storyId: string, fixed: boolean): Action {
  return {
    ...action,
    stories: action.stories.map((s) => (s.id === storyId ? withFixed(s, fixed) : s)),
  };
}
