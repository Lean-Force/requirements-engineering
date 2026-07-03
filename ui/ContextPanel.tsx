"use client";

import { useRef, useState } from "react";
import type { KnowledgeState, SourceMeta } from "@/contracts";

interface Props {
  knowledge: KnowledgeState;
  /** ボード名(アップロード先の表示に使う) */
  boardName: string;
  /** API のベースパス(例: /api/boards/<id>) */
  apiBase: string;
  onUpload: (files: FileList, common: boolean) => Promise<string | null>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  /** 保存済みの原ファイルから知識を再抽出する(エラー文字列を返すと表示) */
  onReextract: (id: string) => Promise<string | null>;
  onClose: () => void;
}

interface Viewer {
  title: string;
  markdown: string | null; // null = 読み込み中
}

export default function ContextPanel({
  knowledge,
  boardName,
  apiBase,
  onUpload,
  onToggle,
  onDelete,
  onReextract,
  onClose,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // アップロード先: false = このボード(業務)の知識 / true = 業務横断の共通知識
  const [asCommon, setAsCommon] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  // 再抽出中のソース id
  const [reextracting, setReextracting] = useState<string | null>(null);

  const pickFiles = () => fileInput.current?.click();

  const reextract = async (id: string) => {
    if (reextracting) return;
    setReextracting(id);
    setError(null);
    const message = await onReextract(id);
    if (message) setError(message);
    setReextracting(null);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    const message = await onUpload(files, asCommon);
    if (message) setError(message);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  // 知識カテゴリの内容を開く
  const openCategory = async (category: string, label: string) => {
    setViewer({ title: label, markdown: null });
    try {
      const res = await fetch(`${apiBase}/contexts/knowledge/${category}`);
      const data = await res.json();
      setViewer({
        title: label,
        markdown: res.ok
          ? (data.markdown as string)
          : `⚠️ ${data.error ?? "読み込みに失敗しました"}`,
      });
    } catch {
      setViewer({ title: label, markdown: "⚠️ 読み込みに失敗しました" });
    }
  };

  // ソースから抽出されたエントリを開く(出典確認)
  const openSource = async (source: SourceMeta) => {
    const title = `${source.fileName} からの抽出結果`;
    setViewer({ title, markdown: null });
    try {
      const res = await fetch(`${apiBase}/contexts/${source.id}`);
      const data = await res.json();
      setViewer({
        title,
        markdown: res.ok
          ? (data.markdown as string)
          : `⚠️ ${data.error ?? "読み込みに失敗しました"}`,
      });
    } catch {
      setViewer({ title, markdown: "⚠️ 読み込みに失敗しました" });
    }
  };

  const { sources, categories } = knowledge;
  const boardSources = sources.filter((s) => s.scope === "board");
  const commonSources = sources.filter((s) => s.scope === "common");
  const totalEntries = categories.reduce((n, c) => n + c.count, 0);

  const renderSource = (s: SourceMeta) => (
    <div key={s.id} className={`context-item${s.enabled ? "" : " off"}`}>
      <div className="context-item-top">
        <div className="context-toggle">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => onToggle(s.id, e.target.checked)}
            aria-label="この資料の知識を AI に提示する"
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
            aria-label="再抽出"
            title="原ファイルから知識を再抽出する"
          >
            {reextracting === s.id ? "…" : "🔄"}
          </button>
          <button
            className="context-delete"
            onClick={() => onDelete(s.id)}
            aria-label="削除"
            title="削除(抽出済みの知識も消えます)"
          >
            ×
          </button>
        </div>
      </div>
      <div className="context-meta">
        {reextracting === s.id ? "AI が再抽出しています…" : `${s.entryCount} 件の知識を抽出`}
      </div>
    </div>
  );

  return (
    <div className="context-panel">
      <div className="context-header">
        <span>ドメイン知識({totalEntries})</span>
        <button className="context-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>

      <div className="context-actions">
        <button
          className="context-upload"
          onClick={pickFiles}
          disabled={uploading}
        >
          {uploading
            ? "AI が知識を抽出しています…"
            : "資料を追加(Excel / CSV / PDF / テキスト)"}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".xlsx,.xls,.csv,.pdf,.md,.txt"
          style={{ display: "none" }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <label className="context-common-toggle">
          <input
            type="checkbox"
            checked={asCommon}
            onChange={(e) => setAsCommon(e.target.checked)}
          />
          業務横断の共通知識として登録(全ボードで参照される)
        </label>
        <div className="context-hint">
          {asCommon
            ? "全社用語集・組織図など、どの業務にも共通する資料向け。"
            : `「${boardName}」の知識として登録します。`}
          追加した資料から AI がドメイン知識を抽出し、チーム全員で共有します。
        </div>
        {error && <div className="context-error">⚠️ {error}</div>}
      </div>

      <div className="context-list">
        <div className="context-section-title">知識カテゴリ(ボード + 共通)</div>
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

        <div className="context-section-title">このボードの資料</div>
        {boardSources.length === 0 && (
          <div className="context-empty">
            まだ資料がありません。要件一覧・業務フロー・議事録などを追加すると、
            AI がドメイン知識に分解して蓄積します。
          </div>
        )}
        {boardSources.map(renderSource)}

        {commonSources.length > 0 && (
          <>
            <div className="context-section-title">共通の資料(業務横断)</div>
            {commonSources.map(renderSource)}
          </>
        )}
      </div>

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
