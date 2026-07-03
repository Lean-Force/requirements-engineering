"use client";

import { useRef, useState } from "react";
import type { KnowledgeState, SourceMeta } from "@/contracts";

interface Props {
  knowledge: KnowledgeState;
  onUpload: (files: FileList) => Promise<string | null>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

interface Viewer {
  title: string;
  markdown: string | null; // null = 読み込み中
}

export default function ContextPanel({
  knowledge,
  onUpload,
  onToggle,
  onDelete,
  onClose,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  const pickFiles = () => fileInput.current?.click();

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    const message = await onUpload(files);
    if (message) setError(message);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  // 知識カテゴリの内容を開く
  const openCategory = async (category: string, label: string) => {
    setViewer({ title: label, markdown: null });
    try {
      const res = await fetch(`/api/contexts/knowledge/${category}`);
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
    setViewer({ title: `${source.fileName} からの抽出結果`, markdown: null });
    try {
      const res = await fetch(`/api/contexts/${source.id}`);
      const data = await res.json();
      setViewer({
        title: `${source.fileName} からの抽出結果`,
        markdown: res.ok
          ? (data.markdown as string)
          : `⚠️ ${data.error ?? "読み込みに失敗しました"}`,
      });
    } catch {
      setViewer({
        title: `${source.fileName} からの抽出結果`,
        markdown: "⚠️ 読み込みに失敗しました",
      });
    }
  };

  const { sources, categories } = knowledge;
  const totalEntries = categories.reduce((n, c) => n + c.count, 0);

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
        <div className="context-hint">
          追加した資料から AI がドメイン知識(用語・フロー・制約など)を抽出し、
          チーム全員で共有します。マップ整理の際に必要な知識だけを参照します。
        </div>
        {error && <div className="context-error">⚠️ {error}</div>}
      </div>

      <div className="context-list">
        <div className="context-section-title">知識カテゴリ</div>
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

        <div className="context-section-title">取り込み済み資料</div>
        {sources.length === 0 && (
          <div className="context-empty">
            まだ資料がありません。要件一覧・業務フロー・議事録・用語集などを
            追加すると、AI がドメイン知識に分解して蓄積します。
          </div>
        )}
        {sources.map((s) => (
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
              <button
                className="context-delete"
                onClick={() => onDelete(s.id)}
                aria-label="削除"
                title="削除(抽出済みの知識も消えます)"
              >
                ×
              </button>
            </div>
            <div className="context-meta">
              {s.entryCount} 件の知識を抽出
            </div>
          </div>
        ))}
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
