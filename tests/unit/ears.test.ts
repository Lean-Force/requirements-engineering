// EARS(日本語形式)バリデータの決定的テスト。
// PBI 化の eval が「全要求行が EARS 形式」をこの分類器で判定するため、
// 5 パターンの受理と、形式外の文の拒否を保証する。
import { describe, expect, it } from "vitest";
import { classifyEars } from "@/infrastructure/agent/ears";

describe("classifyEars(日本語 EARS の分類)", () => {
  it("5 パターンをそれぞれ受理する", () => {
    expect(classifyEars("システムは送金依頼を受け付けること。")).toBe("ubiquitous");
    expect(classifyEars("送金金額が入力されたとき、システムは限度額を検証すること。")).toBe("event");
    expect(classifyEars("承認待ちの間、システムは送金の実行を保留すること。")).toBe("state");
    expect(classifyEars("もし残高が不足している場合、システムは依頼を拒否し理由を表示すること。")).toBe("unwanted");
    expect(classifyEars("予約送金機能を備える場合、システムは実行日を指定できること。")).toBe("optional");
  });

  it("句点なし・「〜できること」も受理する", () => {
    expect(classifyEars("システムは履歴を表示できること")).toBe("ubiquitous");
  });

  it("形式外の文は拒否する", () => {
    expect(classifyEars("ユーザーは送金したい。なぜなら便利だからだ。")).toBeNull(); // ストーリー形式
    expect(classifyEars("送金上限は 1 億円とする。")).toBeNull(); // 主語がシステムでない
    expect(classifyEars("システムが落ちないようにする")).toBeNull(); // 骨格に合わない
    expect(classifyEars("限度額を検証する。")).toBeNull();
  });
});
