// EARS(Easy Approach to Requirements Syntax)の日本語形式の定義と検証。
//
// PBI 化で AI が生成する要求文が EARS のパターンに従っているかを決定的に
// 判定する(eval のアサーションと UI のパターン表示に使う)。
// 日本語形式は次の 5 パターンに揃える(主語は「システムは」、文末は「こと」):
//   ubiquitous : システムは〜すること
//   event      : 〜とき、システムは〜すること
//   state      : 〜間、システムは〜すること
//   unwanted   : もし〜場合、システムは〜すること
//   optional   : 〜を備える場合、システムは〜すること

export type EarsPattern = "ubiquitous" | "event" | "state" | "unwanted" | "optional";

export const EARS_PATTERN_LABELS: Record<EarsPattern, string> = {
  ubiquitous: "通常",
  event: "イベント駆動",
  state: "状態駆動",
  unwanted: "望ましくない挙動",
  optional: "オプション",
};

/**
 * 要求文がどの EARS パターンに適合するか判定する(適合しなければ null)。
 * 判定は形式(構文)のみ。内容の正しさは eval(実 LLM + 事実アサート)が担う。
 */
export function classifyEars(text: string): EarsPattern | null {
  const t = text.trim();
  // すべてのパターンに共通の骨格: 「…システムは…こと。」で終わる
  // (動詞は限定しない。「進めること」「送ること」なども正しい EARS 文)
  if (!/システムは.+こと。?$/.test(t)) return null;

  if (/^もし.+(場合|ならば)、?システムは/.test(t)) return "unwanted";
  if (/^.+を備える場合、?システムは/.test(t)) return "optional";
  if (/^.+(とき|時)、?システムは/.test(t)) return "event";
  if (/^.+(間|中)は?、?システムは/.test(t)) return "state";
  if (/^システムは/.test(t)) return "ubiquitous";
  return null;
}
