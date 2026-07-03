// インフラ層: プロセス内イベントバス(SSE でのボード同期用)。
//
// 「どのボードで何が変わった」を接続中の全リスナーへ push する(薄い通知 →
// クライアントが再取得)。SSE ルート側で自分のボード宛(または全ボード宛 "*")
// だけをクライアントへ流す。単一レプリカ前提。スケールアウト時は Redis pub/sub 等へ。
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

/** boardId には対象ボードの id、全ボード向け(共通知識の変更など)は "*" を渡す */
export function emit(boardId: string, type: BoardEvent["type"]): void {
  const event: BoardEvent = { type, boardId, at: new Date().toISOString() };
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch {
      /* 切断済みクライアントへの送信失敗は無視 */
    }
  }
}
