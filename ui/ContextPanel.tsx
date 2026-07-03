"use client";

import { useRef, useState } from "react";
import type { ContextDocMeta } from "@/contracts";

interface Props {
  docs: ContextDocMeta[];
  onUpload: (files: FileList) => Promise<string | null>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

interface Viewer {
  fileName: string;
  markdown: string | null; // null = 読み込み中
}

export default function ContextPanel({
  docs,
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

  // ファイル名クリックで変換後の内容を開く
  const openDoc = async (doc: ContextDocMeta) => {
    setViewer({ fileName: doc.fileName, markdown: null });
    try {
      const res = await fetch(`/api/contexts/${doc.id}`);
      const data = await res.json();
      if (!res.ok) {
        setViewer({ fileName: doc.fileName, markdown: `⚠️ ${data.error ?? "読み込みに失敗しました"}` });
        return;
      }
      setViewer({ fileName: doc.fileName, markdown: data.markdown as string });
    } catch {
      setViewer({ fileName: doc.fileName, markdown: "⚠️ 読み込みに失敗しました" });
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    const message = await onUpload(files);
    if (message) setError(message);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const enabledCount = docs.filter((d) => d.enabled).length;

  return (
    <div className="context-panel">
      <div className="context-header">
        <span>コンテキスト({enabledCount}/{docs.length} 有効)</span>
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
          {uploading ? "取り込み中…" : "ファイルを追加(Excel / CSV / PDF / テキスト)"}
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
          追加した資料はチーム全員に共有され、AI が必要と判断したときに参照します。
        </div>
        {error && <div className="context-error">⚠️ {error}</div>}
      </div>

      <div className="context-list">
        {docs.length === 0 && (
          <div className="context-empty">
            まだ資料がありません。要件一覧・業務フロー・議事録・用語集などの
            Excel / PDF / テキストを追加すると、AI がマップ整理の根拠として参照します。
          </div>
        )}

        {docs.map((d) => (
          <div key={d.id} className={`context-item${d.enabled ? "" : " off"}`}>
            <div className="context-item-top">
              <div className="context-toggle">
                <input
                  type="checkbox"
                  checked={d.enabled}
                  onChange={(e) => onToggle(d.id, e.target.checked)}
                  aria-label="AI に提示する"
                  title="AI に提示する"
                />
                <button
                  className="context-name"
                  onClick={() => openDoc(d)}
                  title="内容を表示"
                >
                  {d.fileName}
                </button>
              </div>
              <button
                className="context-delete"
                onClick={() => onDelete(d.id)}
                aria-label="削除"
                title="削除"
              >
                ×
              </button>
            </div>
            <div className="context-desc">{d.description}</div>
            <div className="context-meta">
              {d.charCount.toLocaleString()} 文字
            </div>
          </div>
        ))}
      </div>

      {viewer && (
        <div className="context-viewer-backdrop" onClick={() => setViewer(null)}>
          <div className="context-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="context-viewer-header">
              <span>{viewer.fileName}</span>
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
