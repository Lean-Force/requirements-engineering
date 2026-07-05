"use client";

// AI へ注入される標準コンテキストのサイズメーター(モデル上限比)。
// 知識が育って肥大化したら選択的提示へ切り替える判断材料(TESTING.md / 運用)。

import type { ContextSize } from "@/contracts";

export default function ContextSizeMeter({ size }: { size: ContextSize }) {
  if (size.windowTokens <= 0) return null;
  const pct = (size.tokens / size.windowTokens) * 100;
  const level = pct >= 50 ? "danger" : pct >= 20 ? "warn" : "ok";
  const fmt = (n: number) => n.toLocaleString("ja-JP");
  return (
    <div
      className={`context-size ${level}`}
      title="チャット・校正・抽出などすべての AI 行動の system prompt に注入される参照情報(業務一覧・知識・共通知識・確定マップ・現在のマップ)の概算サイズ"
    >
      <span>
        AI へのコンテキスト: 約 {fmt(size.tokens)} トークン
        (上限 {fmt(size.windowTokens)} の {pct < 1 ? "1%未満" : `${Math.round(pct)}%`})
      </span>
      <div className="context-size-bar">
        <div style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}
