// 構造化出力のスキーマ。StoryMap の形はドメイン(domain/schema.ts)を単一の情報源とする。

import { STORY_MAP_JSON_SCHEMA } from "@/domain/schema";

/** チャット応答(reply + 更新後マップ)のスキーマ */
export const CHAT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "storyMap"],
  properties: {
    reply: { type: "string" },
    storyMap: STORY_MAP_JSON_SCHEMA,
  },
};

/** ドメイン知識抽出のスキーマ */
export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "content"],
        properties: {
          category: {
            type: "string",
            enum: ["terms", "actors", "flows", "data", "background"],
          },
          title: { type: "string" },
          content: { type: "string" },
        },
      },
    },
  },
};
