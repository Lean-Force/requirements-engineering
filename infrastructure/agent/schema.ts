// 構造化出力のスキーマ。StoryMap の形はドメイン(domain/schema.ts)を単一の情報源とする。

import { STORY_MAP_JSON_SCHEMA } from "@/domain/schema";

/** チャット応答(reply + 更新後マップ)のスキーマ */
export const CHAT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "storyMap"],
  properties: {
    reply: { type: "string" },
    // マップを変更しないターンは null(マップ全体の再出力を省き、応答を速くする)
    storyMap: {
      anyOf: [STORY_MAP_JSON_SCHEMA, { type: "null" }],
      description:
        "更新後のマップ全体。マップを一切変更しないターンでは null(現在のマップが維持される)",
    },
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
        required: ["category", "title", "content", "common"],
        properties: {
          category: {
            type: "string",
            enum: ["terms", "actors", "flows", "data", "background"],
          },
          title: { type: "string" },
          content: { type: "string" },
          common: {
            type: "boolean",
            description: "true = 業務横断で通用する共通知識(全社用語・組織・共通規程など)",
          },
        },
      },
    },
  },
};

/** 付箋校正(refine)の構造化出力スキーマ */
export const REFINE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["suggestion", "note"],
  properties: {
    suggestion: {
      type: "string",
      description: "付箋にそのまま入れられる推敲後の本文",
    },
    note: { type: "string", description: "何をなぜ直したかの短い説明(日本語1〜2文)" },
  },
};

/** 会話履歴の要約(compaction)の構造化出力スキーマ */
export const SUMMARIZE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: {
      type: "string",
      description: "これまでの経緯の要約(決定事項・理由・指示・未解決点を保持した Markdown)",
    },
  },
};

/** エントリ修正案(revise)の構造化出力スキーマ */
export const ENTRY_REVISE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content", "common", "note"],
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    common: {
      type: "boolean",
      description: "true = 業務横断で通用する共通知識",
    },
    note: { type: "string", description: "何をどう直したか・原資料との食い違いの指摘(日本語1〜2文)" },
  },
};

/** 矛盾検出の構造化出力スキーマ */
export const CONFLICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["conflicts"],
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "newClaim", "existingSource", "existingClaim"],
        properties: {
          topic: { type: "string", description: "何についての食い違いか(短く)" },
          newClaim: { type: "string", description: "新しい資料側の主張" },
          existingSource: { type: "string", description: "既存側の出典ラベル(与えられたものをそのまま)" },
          existingClaim: { type: "string", description: "既存側の主張" },
        },
      },
    },
  },
};

/** 新業務検知の構造化出力スキーマ */
export const BUSINESS_DETECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["isNewBusiness", "name", "reason"],
  properties: {
    isNewBusiness: { type: "boolean" },
    name: { type: "string", description: "業務名の候補(false のときは空文字)" },
    reason: { type: "string", description: "判定理由(日本語1〜2文)" },
  },
};
