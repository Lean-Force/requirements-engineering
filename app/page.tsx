"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardMeta } from "@/contracts";

// ボード(= 業務)一覧。ボードを選ぶ / 作るとマップ画面(/boards/<id>)へ。
export default function BoardListPage() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/boards")
      .then((r) => r.json())
      .then((list: BoardMeta[]) => setBoards(list))
      .catch(() => {
        /* 取得失敗時は空のまま */
      })
      .finally(() => setReady(true));
  }, []);

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data.error as string) ?? "作成に失敗しました");
        return;
      }
      router.push(`/boards/${(data as BoardMeta).id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreating(false);
    }
  }, [name, creating, router]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  };

  return (
    <div className="board-list-page">
      <header className="board-list-header">
        <h1>USM AI Chat</h1>
        <span className="sub">業務ごとにボードを作り、AI と対話しながら User Story Map を構築・整理</span>
      </header>

      <div className="board-create">
        <input
          type="text"
          value={name}
          placeholder="新しいボード名(例: 送金処理)"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <button onClick={create} disabled={creating || !name.trim()}>
          {creating ? "作成中…" : "ボードを作成"}
        </button>
      </div>
      {error && <div className="board-list-error">⚠️ {error}</div>}

      <div className="board-list">
        {!ready && <div className="board-list-empty">読み込み中…</div>}
        {ready && boards.length === 0 && (
          <div className="board-list-empty">
            まだボードがありません。業務の名前でボードを作成してください。
          </div>
        )}
        {boards.map((b) => (
          <button
            key={b.id}
            className="board-card"
            onClick={() => router.push(`/boards/${b.id}`)}
          >
            <span className="board-card-name">{b.name}</span>
            <span className="board-card-date">{formatTime(b.createdAt)} 作成</span>
          </button>
        ))}
      </div>
    </div>
  );
}
