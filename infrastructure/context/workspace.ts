// インフラ層: コンテキスト(知識ベース)のワークスペースの場所。
// agent(LLM ゲートウェイ)と store(知識ベース)の両方から参照されるため独立させている。

import path from "path";

// CONTEXT_WORKSPACE で差し替え可能(E2E の隔離用)
export function workspaceDir(): string {
  return process.env.CONTEXT_WORKSPACE
    ? path.resolve(process.env.CONTEXT_WORKSPACE)
    : path.join(process.cwd(), "data", "workspace");
}
