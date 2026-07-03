// インフラ層: チャットターンの直列化(ボード単位のミューテックス)。
//
// 同じボード(= 業務)を共有するメンバーの AI ターンを同時に走らせると
// 版履歴と会話が後勝ちで壊れる(load → modify → save の競合)。
// ボードごとにターンを到着順に 1 つずつ処理することで整合性を守る。
// 別ボード同士は並行して動ける。単一レプリカ前提(スケールアウト時は分散ロックへ)。

const globalStore = globalThis as unknown as {
  __usmChatQueues?: Map<string, Promise<unknown>>;
};

function queues(): Map<string, Promise<unknown>> {
  globalStore.__usmChatQueues ??= new Map();
  return globalStore.__usmChatQueues;
}

/** fn を「同じボードの先行ターンが全て終わってから」実行する */
export function withChatLock<T>(boardId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues().get(boardId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // 失敗しても後続が詰まらないようにする
  queues().set(boardId, run.catch(() => undefined));
  return run;
}
