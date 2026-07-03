"use client";

// 取り込み時に検出された知識の矛盾一覧(ボードのパネルと /knowledge で共用)。
// 矛盾は「意思決定の種」: どちらが正かをチームが決め、エントリを直したら解決済みにする。

import { useState } from "react";
import type { KnowledgeConflict } from "@/contracts";

interface Props {
  conflicts: KnowledgeConflict[];
  /** 解決済みにする(エラー文字列を返すと表示) */
  onDismiss: (id: string) => Promise<string | null>;
}

export default function ConflictList({ conflicts, onDismiss }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (conflicts.length === 0) return null;

  const dismiss = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    const message = await onDismiss(id);
    if (message) setError(message);
    setBusy(null);
  };

  return (
    <>
      <div className="context-section-title conflict-title">
        ⚠️ 矛盾の疑い({conflicts.length})
      </div>
      {error && <div className="context-error">⚠️ {error}</div>}
      {conflicts.map((c) => (
        <div key={c.id} className="conflict-item">
          <div className="conflict-topic">
            <span>{c.topic}</span>
            <button
              className="conflict-dismiss"
              title="解決済みにする(一覧から消す)"
              disabled={busy !== null}
              onClick={() => dismiss(c.id)}
            >
              {busy === c.id ? "…" : "解決済み"}
            </button>
          </div>
          <div className="conflict-claim">
            <span className="conflict-side">新</span>
            {c.newClaim}
            <span className="conflict-source">({c.newSource})</span>
          </div>
          <div className="conflict-claim">
            <span className="conflict-side old">既存</span>
            {c.existingClaim}
            <span className="conflict-source">({c.existingSource})</span>
          </div>
          <div className="conflict-hint">
            どちらが正かを決めて、資料のエントリを ✏️ で直すか off にしてから「解決済み」にしてください。
          </div>
        </div>
      ))}
    </>
  );
}
