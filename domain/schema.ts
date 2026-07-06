// StoryMap の JSON スキーマ(AI の構造化出力用)。
//
// ドメイン型(story-map.ts / activity.ts / action.ts / story.ts)と対で保守する。
// フィールドを増減したら必ずここも更新すること — tests/unit/schema.test.ts が
// ドメインのサンプル値とこのスキーマの同期を検証しており、忘れるとテストが落ちる。
//
// 意図的に含めないフィールド:
//   - Activity.storyOrder … 列の表示順はサーバー管理(applyAiUpdate が引き継ぐ)。
//     AI に見せる必要がなく、勝手に並び替えさせないためスキーマから除外している。

export const STORY_MAP_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["actors", "activities"],
  properties: {
    actors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    activities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "actions"],
        properties: {
          id: { type: "string" },
          standalone: {
            type: "boolean",
            description:
              "時系列(ナラティブフロー)に属さない随時・例外・定期の場面は true。true の場面は配列の末尾に置く",
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "actorId", "text", "stories"],
              properties: {
                id: { type: "string" },
                actorId: { type: "string" },
                text: { type: "string" },
                fixed: { type: "boolean" },
                stories: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "text"],
                    properties: {
                      id: { type: "string" },
                      text: { type: "string" },
                      fixed: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
