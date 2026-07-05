"use client";

// 取り込み時に AI が検知した「新しい業務」のボード作成提案(ボードのパネルと /knowledge で共用)。
// 承認するとボードが作られ、提案のもとになった資料(知識ごと)が新しいボードへ移り、
// 叩き台の生成へ遷移する。

import { useState } from "react";
import type { BoardProposal } from "@/contracts";

interface Props {
  proposals: BoardProposal[];
  /** 承認(ボード作成 + 資料移動 + 叩き台へ遷移)。エラー文字列を返すと表示 */
  onAccept: (id: string) => Promise<string | null>;
  /** 却下 */
  onDismiss: (id: string) => Promise<string | null>;
}

export default function ProposalList({ proposals, onAccept, onDismiss }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (proposals.length === 0) return null;

  const run = async (id: string, fn: (id: string) => Promise<string | null>) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    const message = await fn(id);
    if (message) setError(message);
    setBusy(null);
  };

  return (
    <>
      <div className="context-section-title proposal-title">
        💡 新しい業務の可能性({proposals.length})
      </div>
      {error && <div className="context-error">⚠️ {error}</div>}
      {proposals.map((p) => (
        <div key={p.id} className="proposal-item">
          <div className="proposal-name">業務「{p.name}」</div>
          <div className="proposal-reason">
            {p.reason}
            <span className="proposal-source">(資料: {p.fileName})</span>
          </div>
          <div className="proposal-actions">
            <button
              className="proposal-accept"
              disabled={busy !== null}
              onClick={() => run(p.id, onAccept)}
            >
              {busy === p.id ? "作成中…" : "ボードを作って叩き台へ"}
            </button>
            <button
              className="proposal-dismiss"
              disabled={busy !== null}
              onClick={() => run(p.id, onDismiss)}
            >
              却下
            </button>
          </div>
          <div className="proposal-hint">
            承認すると資料と抽出済みの知識が新しいボードへ移ります。
          </div>
        </div>
      ))}
    </>
  );
}
