"use client";

// 共通知識(業務横断)の集約ビュー。資料のアップロード口は各ボードの知識パネル
// だけ(一本化)で、共通かどうかは AI が抽出時に判定する。ここでは全業務から
// 集まった共通知識の閲覧・編集・整備を行う(過去に直接追加された共通資料の管理も)。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { KnowledgeState, SourceMeta } from "@/contracts";
import { useRouter } from "next/navigation";
import ConflictList from "@/ui/ConflictList";
import ContextSizeMeter from "@/ui/ContextSizeMeter";
import ProposalList from "@/ui/ProposalList";
import SourceEntriesViewer from "@/ui/SourceEntriesViewer";

const EMPTY: KnowledgeState = {
  sources: [],
  categories: [],
  conflicts: [],
  proposals: [],
  contextSize: { chars: 0, tokens: 0, windowTokens: 200_000 },
};

interface Viewer {
  title: string;
  markdown: string | null;
}

export default function KnowledgeAdminPage() {
  const router = useRouter();
  const [knowledge, setKnowledge] = useState<KnowledgeState>(EMPTY);
  const [ready, setReady] = useState(false);
  const [reextracting, setReextracting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  // エントリ編集ビューアを開いている資料
  const [entriesFor, setEntriesFor] = useState<SourceMeta | null>(null);

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

  // ボード作成提案の承認 / 却下
  const acceptProposal = useCallback(async (proposalId: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/knowledge/proposals/${proposalId}/accept`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) return (data.error as string) ?? "作成に失敗しました";
      const { board } = data as { board: { id: string } };
      router.push(`/boards/${board.id}?bootstrap=1`);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "作成に失敗しました";
    }
  }, [router]);

  const dismissProposal = useCallback(async (proposalId: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/knowledge/proposals/${proposalId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return (data.error as string) ?? "操作に失敗しました";
      setKnowledge(data as KnowledgeState);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "操作に失敗しました";
    }
  }, []);

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
        <h1>全業務の共通知識</h1>
        <span className="sub">
          すべてのボード(業務)から参照される知識の集約ビューです。資料の追加は
          各ボードの「ドメイン知識」パネルから行い、業務横断かどうかは AI が判定して
          ここへ集めます —{" "}
          <Link href="/">ボードへ戻る</Link>
        </span>
      </header>

      {error && <div className="board-list-error">⚠️ {error}</div>}
      <ContextSizeMeter size={knowledge.contextSize} />

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

        <ProposalList
          proposals={knowledge.proposals}
          onAccept={acceptProposal}
          onDismiss={dismissProposal}
        />
        <ConflictList conflicts={knowledge.conflicts} onDismiss={dismissConflict} />

        {sources.length > 0 && (
          <div className="context-section-title">共通スコープの資料</div>
        )}
        {ready && totalEntries === 0 && sources.length === 0 && (
          <div className="context-empty">
            まだ共通知識がありません。各ボードで全社用語集・組織図・共通規程などを
            取り込むと、AI が業務横断と判定した知識がここに集まります。
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
