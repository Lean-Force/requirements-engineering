// ドメイン型と AI 出力スキーマ(domain/schema.ts)の同期を保証するテスト。
//
// ドメインにフィールドを足したのにスキーマの更新を忘れると、AI の出力から
// その情報が黙って落ちる(additionalProperties: false のため)。このテストは
// 「全フィールドを使ったサンプル値」とスキーマの properties を再帰的に突き合わせ、
// ずれたら落ちるようにしている。
import { describe, expect, it } from "vitest";
import { STORY_MAP_JSON_SCHEMA } from "@/domain/schema";
import { normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";

// 全フィールドを埋めたサンプル(ドメイン型が広がったらここも広げる = 型エラーで気付ける)
const FULL_SAMPLE: Required<Pick<StoryMap, "actors" | "activities" | "releases">> = {
  releases: [{ name: "MVP" }, { name: "フェーズ2" }],
  actors: [{ id: "a1", name: "店員" }],
  activities: [
    {
      id: "act1",
      standalone: true, // 随時(時系列外)のステップ
      flowName: "受付", // 小さな流れの名前
      // ストーリーに release を足す場合は actions 内の stories に追加
      storyOrder: ["s1"], // ← AI スキーマからは意図的に除外(サーバー管理)
      actions: [
        {
          id: "ac1",
          actorId: "a1",
          text: "会計する",
          fixed: true,
          stories: [{ id: "s1", text: "…したい", fixed: true, release: 1 }],
        },
      ],
    },
  ],
};

// スキーマから意図的に除外しているフィールド(理由は domain/schema.ts 参照)
const INTENTIONALLY_EXCLUDED = new Set(["activities.items.storyOrder"]);

type Schema = { properties?: Record<string, Schema>; items?: Schema };

function schemaKeys(schema: Schema, base: string): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const p = base ? `${base}.${key}` : key;
    out.push(p);
    const inner = child.items ? { node: child.items, path: `${p}.items` } : { node: child, path: p };
    out.push(...schemaKeys(inner.node, inner.path));
  }
  return out;
}

function sampleKeys(value: unknown, base: string): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const v of value) out.push(...sampleKeys(v, `${base}.items`));
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      const p = base ? `${base}.${key}` : key;
      out.push(p);
      out.push(...sampleKeys(v, p));
    }
  }
  return [...new Set(out)];
}

describe("StoryMap の JSON スキーマとドメイン型の同期", () => {
  it("サンプル値の全フィールドがスキーマに存在する(除外リスト以外)", () => {
    const inSchema = new Set(schemaKeys(STORY_MAP_JSON_SCHEMA as Schema, ""));
    const missing = sampleKeys(FULL_SAMPLE, "").filter(
      (k) => !inSchema.has(k) && !INTENTIONALLY_EXCLUDED.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("スキーマ側にドメインに無い余分なフィールドがない", () => {
    const inSample = new Set([
      ...sampleKeys(FULL_SAMPLE, ""),
      ...INTENTIONALLY_EXCLUDED,
    ]);
    const extras = schemaKeys(STORY_MAP_JSON_SCHEMA as Schema, "").filter(
      (k) => !inSample.has(k),
    );
    expect(extras).toEqual([]);
  });

  it("サンプル値は normalize を素通りする(スキーマ通りの値が保存可能)", () => {
    const n = normalizeStoryMap(FULL_SAMPLE as StoryMap);
    expect(n.activities[0].actions[0].fixed).toBe(true);
    expect(n.activities[0].storyOrder).toEqual(["s1"]);
  });
});
