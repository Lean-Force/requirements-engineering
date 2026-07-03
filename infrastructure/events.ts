// インフラ層: プロセス内イベントバス(SSE でのボード同期用)。
//
// チーム全員が 1 枚のマップを共有する前提で、「何かが変わった」ことだけを
// 接続中の全クライアントへ push する(薄い通知 → クライアントが再取得)。
// 単一レプリカ前提。スケールアウト時は Redis pub/sub 等へ差し替える。
//
// Next.js の dev サーバー(HMR)でモジュールが再評価されても購読が
// 失われないよう、リスナー集合は globalThis に 1 つだけ保持する。

import type { BoardEvent } from "@/contracts";

type Listener = (event: BoardEvent) => void;

const globalStore = globalThis as unknown as {
  __usmEventListeners?: Set<Listener>;
};

function listeners(): Set<Listener> {
  globalStore.__usmEventListeners ??= new Set();
  return globalStore.__usmEventListeners;
}

export function subscribe(listener: Listener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

export function emit(type: BoardEvent["type"]): void {
  const event: BoardEvent = { type, at: new Date().toISOString() };
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch {
      /* 切断済みクライアントへの送信失敗は無視 */
    }
  }
}
