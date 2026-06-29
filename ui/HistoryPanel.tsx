"use client";

import type { StoryMapVersionMeta } from "@/contracts";

interface Props {
  versions: StoryMapVersionMeta[];
  restoringId: string | null;
  onRestore: (id: string) => void;
  onClose: () => void;
}

const SOURCE_LABEL: Record<StoryMapVersionMeta["source"], string> = {
  chat: "AI",
  edit: "編集",
  restore: "復元",
};

function formatTime(iso: string): string {
  // ロケール依存を避け、MM/DD HH:mm を手組みする
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function HistoryPanel({
  versions,
  restoringId,
  onRestore,
  onClose,
}: Props) {
  // 新しい版を上に表示する
  const items = [...versions].reverse();

  return (
    <div className="history-panel">
      <div className="history-header">
        <span>版履歴(最新{versions.length})</span>
        <button className="history-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>

      <div className="history-list">
        {items.length === 0 && (
          <div className="history-empty">
            まだ履歴がありません。AI との対話やボード編集を行うと、ここに版が積まれます。
          </div>
        )}

        {items.map((v) => (
          <div key={v.id} className="history-item">
            <div className="history-item-top">
              <span className={`history-badge ${v.source}`}>
                {SOURCE_LABEL[v.source]}
              </span>
              <span className="history-time">{formatTime(v.createdAt)}</span>
            </div>
            <div className="history-summary">{v.summary}</div>
            <button
              className="history-restore"
              onClick={() => onRestore(v.id)}
              disabled={restoringId !== null}
            >
              {restoringId === v.id ? "復元中…" : "この版に復元"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
