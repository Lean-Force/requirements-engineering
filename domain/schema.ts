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
    releases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", description: "リリースの名前(例: MVP / フェーズ2)" },
        },
      },
      description: "リリースの定義(index 0 = MVP/リリース1 …)。省略は MVP のみ",
    },
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
              "時系列(ナラティブフロー)に属さない随時・例外・定期のステップは true。true のステップは配列の末尾に置く",
          },
          flowName: {
            type: "string",
            description:
              "アクティビティ(連続するステップをまとめる帯)の名前(例: 受付 / 審査・承認 / 実行・通知)。意味のまとまりごとに付け、同じ名前のステップは隣接させる。短い名詞。standalone のステップには付けない",
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
                      release: {
                        type: "integer",
                        description:
                          "リリース番号(0 = MVP/リリース1、1 = リリース2 …)。省略は 0(MVP)。マップを横に切って優先順位を決める。",
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
  },
};
