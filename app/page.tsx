"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardMeta } from "@/contracts";

// エントリページ。ボードがあれば「最後に開いたボード」へ直行し、
// 無ければ最初のボードの作成フォームを出す(切替はボード画面のプルダウンで行う)。
export default function BoardListPage() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/boards")
      .then((r) => r.json())
      .then((list: BoardMeta[]) => {
        if (list.length > 0) {
          // 最後に開いたボード(無効なら先頭)へ直行
          let target = list[0].id;
          try {
            const last = localStorage.getItem("usm:lastBoard");
            if (last && list.some((b) => b.id === last)) target = last;
          } catch {
            /* localStorage が使えなければ先頭へ */
          }
          router.replace(`/boards/${target}`);
          return;
        }
        setBoards(list);
        setReady(true);
      })
      .catch(() => {
        setReady(true);
      });
  }, [router]);

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || phase !== "idle") return;
    setPhase("creating");
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
      const board = data as BoardMeta;
      router.push(`/boards/${board.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setPhase("idle");
    }
  }, [name, phase, router]);

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
          placeholder="新しいボード名(業務名。例: 送金処理)"
          disabled={phase !== "idle"}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <button onClick={create} disabled={phase !== "idle" || !name.trim()}>
          {phase === "creating" ? "作成中…" : "ボードを作成"}
        </button>
      </div>
      <div className="board-list-hint">
        資料はボード作成後に「ドメイン知識」パネルから追加してください。別の業務の資料を
        取り込むと、AI が新しいボードの作成を提案します。
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
