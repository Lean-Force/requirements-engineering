// インフラ層: チャットターンの直列化(グローバルミューテックス)。
//
// チーム全員が 1 枚のマップを共有するため、AI ターンを同時に走らせると
// 版履歴と会話が後勝ちで壊れる(load → modify → save の競合)。
// ターンを到着順に 1 つずつ処理することで整合性を守る。
// 単一レプリカ前提(スケールアウト時は分散ロックへ差し替え)。

const globalStore = globalThis as unknown as {
  __usmChatQueue?: Promise<unknown>;
};

/** fn を「先行するチャットターンが全て終わってから」実行する */
export function withChatLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalStore.__usmChatQueue ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // 失敗しても後続が詰まらないようにする
  globalStore.__usmChatQueue = run.catch(() => undefined);
  return run;
}
