"use client";

// 共通知識(業務横断)の管理ページ。ボードを開かずに GLOBAL を整備する場所。
// ここで追加した資料の知識はすべて共通になる。カテゴリには、各ボードの資料から
// AI が共通へ振り分けた知識も合わせて表示される(それらの資料の管理は各ボード側)。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { KnowledgeState, SourceMeta } from "@/contracts";
import ConflictList from "@/ui/ConflictList";
import SourceEntriesViewer from "@/ui/SourceEntriesViewer";

const EMPTY: KnowledgeState = { sources: [], categories: [], conflicts: [] };

interface Viewer {
  title: string;
  markdown: string | null;
}

export default function KnowledgeAdminPage() {
  const [knowledge, setKnowledge] = useState<KnowledgeState>(EMPTY);
  const [ready, setReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reextracting, setReextracting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  // エントリ編集ビューアを開いている資料
  const [entriesFor, setEntriesFor] = useState<SourceMeta | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/knowledge");
      setKnowledge((await res.json()) as KnowledgeState);
    } catch {
      /* 失敗時は手元のまま */
    }
  }, []);

  useEffect(() => {
    refetch().finally(() => setReady(true));
  }, [refetch]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    try {
      const res = await fetch("/api/knowledge", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) setError((data.error as string) ?? "アップロードに失敗しました");
      else setKnowledge(data as KnowledgeState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setKnowledge((prev) => ({
      ...prev,
      sources: prev.sources.map((s) => (s.id === id ? { ...s, enabled } : s)),
    }));
    const res = await fetch(`/api/knowledge/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).catch(() => null);
    if (res?.ok) setKnowledge((await res.json()) as KnowledgeState);
  };

  const remove = async (source: SourceMeta) => {
    if (
      !window.confirm(
        `共通知識「${source.fileName}」を削除しますか?\n全ボードから参照できなくなります。`,
      )
    )
      return;
    const res = await fetch(`/api/knowledge/${source.id}`, { method: "DELETE" }).catch(
      () => null,
    );
    if (res?.ok) setKnowledge((await res.json()) as KnowledgeState);
  };

  const reextract = async (id: string) => {
    if (reextracting) return;
    setReextracting(id);
    setError(null);
    try {
      const res = await fetch(`/api/knowledge/${id}/reextract`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setError((data.error as string) ?? "再抽出に失敗しました");
      else setKnowledge(data as KnowledgeState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "再抽出に失敗しました");
    } finally {
      setReextracting(null);
    }
  };

  const openCategory = async (category: string, label: string) => {
    setViewer({ title: `${label}(共通)`, markdown: null });
    try {
      const res = await fetch(`/api/knowledge/categories/${category}`);
      const data = await res.json();
      setViewer({
        title: `${label}(共通)`,
        markdown: res.ok ? (data.markdown as string) : `⚠️ ${data.error}`,
      });
    } catch {
      setViewer({ title: label, markdown: "⚠️ 読み込みに失敗しました" });
    }
  };

  const openSource = (source: SourceMeta) => setEntriesFor(source);

  // 矛盾を解決済みにする
  const dismissConflict = useCallback(async (conflictId: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/knowledge/conflicts/${conflictId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return (data.error as string) ?? "操作に失敗しました";
      setKnowledge(data as KnowledgeState);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "操作に失敗しました";
    }
  }, []);

  // 資料 1 件のエントリ操作 API(一覧・AI 修正案・保存・削除)
  const entriesApiFor = useCallback((sourceId: string) => {
    const base = `/api/knowledge/${sourceId}/entries`;
    const call = async (url: string, init?: RequestInit) => {
      try {
        const res = await fetch(url, init);
        const data = await res.json();
        return res.ok ? data : { error: (data.error as string) ?? "操作に失敗しました" };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "操作に失敗しました" };
      }
    };
    return {
      list: () => call(base),
      revise: (entryId: string, instruction: string) =>
        call(`${base}/${entryId}/revise`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction }),
        }),
      save: (entryId: string, patch: unknown) =>
        call(`${base}/${entryId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      remove: (entryId: string) => call(`${base}/${entryId}`, { method: "DELETE" }),
    };
  }, []);

  const { sources, categories } = knowledge;
  const totalEntries = categories.reduce((n, c) => n + c.count, 0);

  return (
    <div className="board-list-page">
      <header className="board-list-header">
        <h1>共通知識(業務横断)</h1>
        <span className="sub">
          すべてのボード(業務)から参照される知識です。各ボードの資料から AI が
          自動で振り分けた知識もここに集まります —{" "}
          <Link href="/">ボードへ戻る</Link>
        </span>
      </header>

      <div className="board-create">
        <button
          className="context-upload"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
        >
          {uploading
            ? "AI が知識を抽出しています…"
            : "共通知識を追加(Excel / CSV / PDF / テキスト)"}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".xlsx,.xls,.csv,.pdf,.md,.txt"
          style={{ display: "none" }}
          onChange={(e) => upload(e.target.files)}
        />
      </div>
      {error && <div className="board-list-error">⚠️ {error}</div>}

      <div className="context-list knowledge-admin-list">
        <div className="context-section-title">知識カテゴリ({totalEntries})</div>
        {categories.map((c) => (
          <button
            key={c.category}
            className="kb-category"
            onClick={() => openCategory(c.category, c.label)}
            disabled={c.count === 0}
          >
            <span>{c.label}</span>
            <span className="kb-count">{c.count}</span>
          </button>
        ))}

        <ConflictList conflicts={knowledge.conflicts} onDismiss={dismissConflict} />

        <div className="context-section-title">ここで追加した資料</div>
        {ready && sources.length === 0 && (
          <div className="context-empty">
            ここで追加した資料はまだありません。全社用語集・組織図・共通規程などを
            追加すると、すべてのボードの AI から参照されます。
          </div>
        )}
        {sources.map((s) => (
          <div key={s.id} className={`context-item${s.enabled ? "" : " off"}`}>
            <div className="context-item-top">
              <div className="context-toggle">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => toggle(s.id, e.target.checked)}
                  title="この資料の知識を AI に提示する"
                />
                <button
                  className="context-name"
                  onClick={() => openSource(s)}
                  title="抽出結果を表示"
                >
                  {s.fileName}
                </button>
              </div>
              <div className="context-item-ops">
                <button
                  className="context-reextract"
                  onClick={() => reextract(s.id)}
                  disabled={reextracting !== null}
                  title="原ファイルから知識を再抽出する"
                >
                  {reextracting === s.id ? "…" : "🔄"}
                </button>
                <button
                  className="context-delete"
                  onClick={() => remove(s)}
                  title="削除(全ボードから参照できなくなります)"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="context-meta">
              {reextracting === s.id
                ? "AI が再抽出しています…"
                : `${s.entryCount} 件の知識を抽出`}
            </div>
          </div>
        ))}
      </div>

      {entriesFor && (
        <SourceEntriesViewer
          title={entriesFor.fileName}
          api={entriesApiFor(entriesFor.id)}
          commonFixed
          onState={setKnowledge}
          onClose={() => setEntriesFor(null)}
        />
      )}

      {viewer && (
        <div className="context-viewer-backdrop" onClick={() => setViewer(null)}>
          <div className="context-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="context-viewer-header">
              <span>{viewer.title}</span>
              <button
                className="context-close"
                onClick={() => setViewer(null)}
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <pre className="context-viewer-body">
              {viewer.markdown ?? "読み込み中…"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
