"use client";

// 論点(議論ポイント)のモーダル。対象(ストーリー / タスク / ステップ / ボード全体)の
// 論点を一覧し、追加・解決(結論と理由が必須 = 合意の記録)・再開・削除する。
// target を指定すると対象を絞り、省略時は全論点を対象ラベル付きで表示する。

import { useEffect, useRef, useState } from "react";
import type { DiscussionPoint, DiscussionTarget } from "@/contracts";

export interface DiscussionScope {
  /** 論点を付ける対象。kind = board のときは「全論点の一覧 + ボード全体への追加」になる */
  target: DiscussionTarget;
  /** モーダル見出しに出す対象の説明(例: ストーリー「〜」) */
  label: string;
}

interface Props {
  apiBase: string;
  scope: DiscussionScope;
  points: DiscussionPoint[];
  /** 全論点表示のとき、対象 id → 表示ラベルを引く(ボード側が持つ) */
  labelOf: (target: DiscussionTarget) => string;
  onChanged: () => void;
  onClose: () => void;
}

export default function DiscussionPanel({
  apiBase,
  scope,
  points,
  labelOf,
  onChanged,
  onClose,
}: Props) {
  const [text, setText] = useState("");
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // board スコープは全論点を見せる(ボード全体の追加もできる)。要素スコープはその要素のみ
  const boardWide = scope.target.kind === "board";
  const shown = boardWide
    ? points
    : points.filter(
        (p) => p.target.kind === scope.target.kind && p.target.id === scope.target.id,
      );
  const open = shown.filter((p) => p.status === "open");
  const resolved = shown.filter((p) => p.status === "resolved");

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        alert(body?.error ?? "操作に失敗しました");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!text.trim()) return;
    void call(() =>
      fetch(`${apiBase}/discussions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: scope.target, text }),
      }),
    ).then(() => setText(""));
  };

  const resolve = (id: string) => {
    if (!resolution.trim()) return;
    void call(() =>
      fetch(`${apiBase}/discussions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", resolution }),
      }),
    ).then(() => {
      setResolving(null);
      setResolution("");
    });
  };

  const reopen = (id: string) =>
    void call(() =>
      fetch(`${apiBase}/discussions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen" }),
      }),
    );

  const remove = (id: string) => {
    if (!window.confirm("この論点を削除しますか?(解決済みの結論も消えます)")) return;
    void call(() => fetch(`${apiBase}/discussions/${id}`, { method: "DELETE" }));
  };

  const pointRow = (p: DiscussionPoint) => (
    <li key={p.id} className={`discussion-item ${p.status}`}>
      <div className="discussion-body">
        {boardWide && (
          <span className="discussion-target">[{labelOf(p.target)}]</span>
        )}
        <span className="discussion-text">{p.text}</span>
        {p.status === "resolved" && (
          <div className="discussion-resolution">結論: {p.resolution}</div>
        )}
      </div>
      <div className="discussion-actions">
        {p.status === "open" ? (
          resolving === p.id ? null : (
            <button disabled={busy} onClick={() => setResolving(p.id)}>解決する</button>
          )
        ) : (
          <button disabled={busy} onClick={() => reopen(p.id)}>再開</button>
        )}
        <button className="discussion-delete" disabled={busy} onClick={() => remove(p.id)} title="削除">×</button>
      </div>
      {resolving === p.id && (
        <div className="discussion-resolve-form">
          <textarea
            autoFocus
            value={resolution}
            placeholder="結論と理由(どう決めたか・なぜそう決めたか)"
            onChange={(e) => setResolution(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") resolve(p.id);
            }}
          />
          <div className="discussion-resolve-buttons">
            <button disabled={busy || !resolution.trim()} onClick={() => resolve(p.id)}>
              合意として記録
            </button>
            <button disabled={busy} onClick={() => { setResolving(null); setResolution(""); }}>
              やめる
            </button>
          </div>
        </div>
      )}
    </li>
  );

  return (
    <div className="discussion-overlay" onClick={onClose}>
      <div className="discussion-modal" onClick={(e) => e.stopPropagation()}>
        <div className="discussion-header">
          <h3>💬 論点: {scope.label}</h3>
          <button className="discussion-close" onClick={onClose} title="閉じる(Esc)">×</button>
        </div>

        <div className="discussion-add">
          <textarea
            ref={inputRef}
            value={text}
            placeholder={
              boardWide
                ? "ボード全体の論点(⌘/Ctrl + Enter で追加)"
                : "議論すべきこと・未解決の点(⌘/Ctrl + Enter で追加)"
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") add();
            }}
          />
          <button disabled={busy || !text.trim()} onClick={add}>論点を追加</button>
        </div>

        {open.length === 0 && resolved.length === 0 && (
          <p className="discussion-empty">論点はまだありません。</p>
        )}
        {open.length > 0 && (
          <>
            <h4>未解決 ({open.length})</h4>
            <ul className="discussion-list">{open.map(pointRow)}</ul>
          </>
        )}
        {resolved.length > 0 && (
          <>
            <h4>解決済み ({resolved.length})</h4>
            <ul className="discussion-list">{resolved.map(pointRow)}</ul>
          </>
        )}
      </div>
    </div>
  );
}
