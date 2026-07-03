"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardMeta } from "@/contracts";

interface Props {
  /** 現在開いているボード(読み込み中は null) */
  current: BoardMeta | null;
}

/**
 * ヘッダー左上のボード切替プルダウン(一覧 + 新規作成)。
 * 新規作成時に資料を添付すると、作成 → 知識抽出 → 初期 USM の叩き台生成まで
 * 一気通貫で行う(?bootstrap=1 でボード画面が自動的に AI へ依頼する)。
 */
export default function BoardSwitcher({ current }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<"idle" | "creating" | "extracting">("idle");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
    if (!trimmed || phase !== "idle") return;
    setError(null);
    setPhase("creating");
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

      // 資料が添付されていれば取り込み(知識抽出)→ 叩き台生成つきで遷移
      if (files.length > 0) {
        setPhase("extracting");
        const form = new FormData();
        for (const f of files) form.append("files", f);
        const up = await fetch(`/api/boards/${board.id}/contexts`, {
          method: "POST",
          body: form,
        });
        if (!up.ok) {
          // 取り込み失敗でもボードは開く(パネルから上げ直せる)
          const err = await up.json().catch(() => ({}));
          setError((err.error as string) ?? "資料の取り込みに失敗しました");
          router.push(`/boards/${board.id}`);
          return;
        }
        setName("");
        setFiles([]);
        setOpen(false);
        router.push(`/boards/${board.id}?bootstrap=1`);
        return;
      }

      setName("");
      setOpen(false);
      router.push(`/boards/${board.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setPhase("idle");
    }
  }, [name, files, phase, router]);

  const createLabel =
    phase === "creating"
      ? "作成中…"
      : phase === "extracting"
        ? "知識を抽出中…"
        : files.length > 0
          ? `作成(資料${files.length}件 → 叩き台)`
          : "作成";

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
          <div className="board-switcher-backdrop" onClick={() => phase === "idle" && setOpen(false)} />
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
                type="text"
                value={name}
                placeholder="新しいボード名(業務名)"
                disabled={phase !== "idle"}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                }}
              />
              <button onClick={create} disabled={phase !== "idle" || !name.trim()}>
                {createLabel}
              </button>
            </div>
            <button
              className="board-switcher-attach"
              onClick={() => fileInput.current?.click()}
              disabled={phase !== "idle"}
            >
              📎 {files.length > 0
                ? `資料 ${files.length} 件を添付済み(クリックで選び直し)`
                : "資料を添付して叩き台まで作る(任意)"}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.pdf,.md,.txt"
              style={{ display: "none" }}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            {error && <div className="board-switcher-error">⚠️ {error}</div>}
          </div>
        </>
      )}
    </div>
  );
}
