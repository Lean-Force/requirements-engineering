"use client";

import { useRef, useState } from "react";
import type { KnowledgeState, SourceMeta } from "@/contracts";
import ConflictList from "./ConflictList";
import ProposalList from "./ProposalList";
import SourceEntriesViewer, { type EntriesApi } from "./SourceEntriesViewer";

interface Props {
  knowledge: KnowledgeState;
  /** ボード名(アップロード先の表示に使う) */
  boardName: string;
  onUpload: (files: FileList) => Promise<string | null>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  /** 保存済みの原ファイルから知識を再抽出する(エラー文字列を返すと表示) */
  onReextract: (id: string) => Promise<string | null>;
  /** カテゴリの閲覧用 Markdown を取得する(データ取得は親が担う) */
  loadCategory: (category: string) => Promise<string>;
  /** 資料 1 件のエントリ操作 API(一覧・AI 修正案・保存・削除) */
  entriesApi: (sourceId: string) => EntriesApi;
  /** エントリの保存・削除後の最新状態を反映する */
  onEntriesState: (state: KnowledgeState) => void;
  /** 矛盾を解決済みにする */
  onDismissConflict: (id: string) => Promise<string | null>;
  /** ボード作成提案の承認(作成 + 資料移動 + 叩き台へ遷移)/ 却下 */
  onAcceptProposal: (id: string) => Promise<string | null>;
  onDismissProposal: (id: string) => Promise<string | null>;
  onClose: () => void;
}

interface Viewer {
  title: string;
  markdown: string | null; // null = 読み込み中
}

export default function ContextPanel({
  knowledge,
  boardName,
  onUpload,
  onToggle,
  onDelete,
  onReextract,
  loadCategory,
  entriesApi,
  onEntriesState,
  onDismissConflict,
  onAcceptProposal,
  onDismissProposal,
  onClose,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  // エントリ編集ビューアを開いている資料
  const [entriesFor, setEntriesFor] = useState<SourceMeta | null>(null);
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
    const message = await onUpload(files);
    if (message) setError(message);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  // 知識カテゴリの内容を開く
  const openCategory = async (category: string, label: string) => {
    setViewer({ title: label, markdown: null });
    setViewer({ title: label, markdown: await loadCategory(category) });
  };

  // ソースから抽出されたエントリを開く(出典確認)
  // 資料クリック → エントリ一覧(AI と協働で直せる)
  const openSource = (source: SourceMeta) => setEntriesFor(source);

  const { sources, categories, conflicts, proposals } = knowledge;
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
        {reextracting === s.id
          ? "AI が再抽出しています…"
          : `${s.entryCount} 件の知識を抽出 · ${new Date(s.uploadedAt).toLocaleDateString("ja-JP")} 取込`}
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
        <div className="context-hint">
          「{boardName}」の資料として登録します。AI がドメイン知識を抽出し、
          業務横断の知識は自動で共通知識になります。同名ファイルを追加すると
          資料の更新として扱われ(✍️ 修正済みの知識は保持)、既存の知識との
          矛盾があれば検出して表示します。
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

        <ProposalList
          proposals={proposals}
          onAccept={onAcceptProposal}
          onDismiss={onDismissProposal}
        />
        <ConflictList conflicts={conflicts} onDismiss={onDismissConflict} />

        <div className="context-section-title">この業務の資料</div>
        {sources.length === 0 && (
          <div className="context-empty">
            まだ資料がありません。要件一覧・業務フロー・議事録などを追加すると、
            AI がドメイン知識に分解して蓄積します。
          </div>
        )}
        {sources.map(renderSource)}
      </div>

      {entriesFor && (
        <SourceEntriesViewer
          title={entriesFor.fileName}
          api={entriesApi(entriesFor.id)}
          onState={onEntriesState}
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
