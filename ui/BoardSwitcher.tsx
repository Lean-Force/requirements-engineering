"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardMeta } from "@/contracts";

interface Props {
  /** 現在開いているボード(読み込み中は null) */
  current: BoardMeta | null;
}

/** ヘッダー左上のボード切替プルダウン(一覧 + 新規作成) */
export default function BoardSwitcher({ current }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  // 開くたびに最新の一覧を取得(他メンバーが作ったボードも見える)
  useEffect(() => {
    if (!open) return;
    fetch("/api/boards")
      .then((r) => r.json())
      .then((list: BoardMeta[]) => setBoards(list))
      .catch(() => {
        /* 失敗時は空のまま */
      });
  }, [open]);

  const select = useCallback(
    (id: string) => {
      setOpen(false);
      if (id !== current?.id) router.push(`/boards/${id}`);
    },
    [current, router],
  );

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (res.ok) {
        setName("");
        setOpen(false);
        router.push(`/boards/${(data as BoardMeta).id}`);
      }
    } catch {
      /* 失敗時はメニューを開いたままにする */
    } finally {
      setCreating(false);
    }
  }, [name, creating, router]);

  return (
    <div className="board-switcher">
      <button
        className="board-switcher-btn"
        onClick={() => setOpen((v) => !v)}
        title="ボードを切り替え"
      >
        <h1>{current?.name ?? "…"}</h1>
        <span className="board-switcher-caret">▾</span>
      </button>

      {open && (
        <>
          {/* 外側クリックで閉じるための透明バックドロップ */}
          <div className="board-switcher-backdrop" onClick={() => setOpen(false)} />
          <div className="board-switcher-menu">
            <div className="board-switcher-section">ボード(業務)</div>
            {boards.map((b) => (
              <button
                key={b.id}
                className={`board-switcher-item${b.id === current?.id ? " active" : ""}`}
                onClick={() => select(b.id)}
              >
                <span className="board-switcher-check">
                  {b.id === current?.id ? "✓" : ""}
                </span>
                {b.name}
              </button>
            ))}
            {boards.length === 0 && (
              <div className="board-switcher-empty">読み込み中…</div>
            )}
            <div className="board-switcher-create">
              <input
                ref={nameInput}
                type="text"
                value={name}
                placeholder="新しいボード名"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                }}
              />
              <button onClick={create} disabled={creating || !name.trim()}>
                {creating ? "作成中…" : "作成"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
