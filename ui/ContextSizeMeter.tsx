"use client";

// AI が参照する情報全体のサイズメーター(モデル上限比)。
// チャットではドメイン知識は kb-* skill として必要なときだけ読まれるが、
// 知識管理系(抽出・修正・業務判定)は全文を注入するため、その上限監視に使う。

import type { ContextSize } from "@/contracts";

export default function ContextSizeMeter({ size }: { size: ContextSize }) {
  if (size.windowTokens <= 0) return null;
  const pct = (size.tokens / size.windowTokens) * 100;
  const level = pct >= 50 ? "danger" : pct >= 20 ? "warn" : "ok";
  const fmt = (n: number) => n.toLocaleString("ja-JP");
  return (
    <div
      className={`context-size ${level}`}
      title="AI が参照する情報(業務一覧・ドメイン知識・合意済みマップ・現在のマップ)の概算サイズ。チャットでは知識は必要なときだけ skill として読まれ、知識の取り込み・修正では全文が渡る"
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
