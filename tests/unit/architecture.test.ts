// アーキテクチャテスト(ArchUnit スタイル)。
//
// 層の責務定義(依存ルール)は .dependency-cruiser.cjs が唯一の正。
// このテストはそれを vitest から実行し、違反を「どのファイルがどのルールを
// 破ったか」まで表示して失敗させる。npm run check:deps(CLI)と同じルールが
// npm run test:unit でも守られる。
import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import { cruise } from "dependency-cruiser";
import type { IConfiguration } from "dependency-cruiser";

// .dependency-cruiser.cjs(CommonJS)をルールの唯一の正として読み込む
const config = createRequire(import.meta.url)(
  "../../.dependency-cruiser.cjs",
) as IConfiguration;

describe("アーキテクチャ(層の依存ルール)", () => {
  it("依存ルール違反がない", async () => {
    const result = await cruise(
      ["domain", "infrastructure", "ui", "app", "contracts.ts"],
      {
        ruleSet: { forbidden: config.forbidden },
        validate: true,
        doNotFollow: { path: "node_modules" },
        tsConfig: { fileName: "tsconfig.json" },
        tsPreCompilationDeps: true,
      },
    );

    const output =
      typeof result.output === "string"
        ? (JSON.parse(result.output) as { summary: { violations: unknown[] } })
        : result.output;

    const violations = (output.summary.violations ?? []).map(
      (v) => `${(v as { rule: { name: string } }).rule.name}: ${(v as { from: string }).from} → ${(v as { to: string }).to}`,
    );
    expect(violations).toEqual([]);
  });
});
