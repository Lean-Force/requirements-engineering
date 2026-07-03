// AI 出力の取り込みパイプライン。
//
// チャットで得た「更新後マップ」を保存してよい形に整える手順は順序が命:
//   1. normalize   … 形のゆれ・無効な参照を掃除(AI 出力は信用しない)
//   2. enforceFixed… 確定済みの行動・ストーリーの改変/削除を復元
//   3. preserveStoryOrder … 列の表示順(AI のスキーマ外)を引き継ぐ
//   4. normalize   … 復元・引き継ぎで生じた不整合(消えた id 等)を最終掃除
// この順序を1か所に閉じ込め、呼び出し側(API ルート)は1動詞で済むようにする。

import { enforceFixed } from "./fixed";
import { preserveStoryOrder } from "./ordering";
import { normalizeStoryMap, type StoryMap } from "./story-map";

/** AI の出力マップを、保存してよい形へ整える(確定の保護と表示順の引き継ぎ込み) */
export function applyAiUpdate(before: StoryMap, aiOutput: StoryMap): StoryMap {
  return normalizeStoryMap(
    preserveStoryOrder(before, enforceFixed(before, normalizeStoryMap(aiOutput))),
  );
}
