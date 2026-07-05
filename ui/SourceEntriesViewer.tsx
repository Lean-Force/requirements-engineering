"use client";

// 資料 1 件の抽出エントリを一覧・編集するビューア(ボードのパネルと /knowledge で共用)。
// エントリ単位で「AI と協働で直す」: 修正指示 → ✨ AI 修正案(原資料を根拠に生成、
// 原文との食い違いは note で指摘)→ フィールドに反映 → 保存(edited = 再抽出でも上書きされない)。
// 手で直接直して保存してもよい。
// スコープ(業務横断か)の判断は AI の責務: トグルは置かず、変えたいときは修正指示に
// 自然文で書く(例「これは全社共通のはず」)。AI が common を判定し直し、理由を note で返す。

import { useEffect, useState } from "react";
import type {
  EntryPatch,
  EntryRevision,
  KnowledgeEntry,
  KnowledgeState,
} from "@/contracts";

const CATEGORY_LABELS: Record<string, string> = {
  terms: "用語集",
  actors: "アクター",
  flows: "業務フロー・ルール",
  data: "データ・IF定義",
  background: "背景・課題",
};

export interface EntriesApi {
  list: () => Promise<{ entries: KnowledgeEntry[] } | { error: string }>;
  revise: (
    entryId: string,
    instruction: string,
  ) => Promise<EntryRevision | { error: string }>;
  save: (
    entryId: string,
    patch: EntryPatch,
  ) => Promise<KnowledgeState | { error: string }>;
  remove: (entryId: string) => Promise<KnowledgeState | { error: string }>;
}

interface Props {
  /** ビューアの見出し(資料名) */
  title: string;
  api: EntriesApi;
  /** 保存・削除後の最新状態を親へ返す(パネルの件数表示の更新用) */
  onState: (state: KnowledgeState) => void;
  onClose: () => void;
}

interface Draft extends EntryPatch {
  instruction: string;
  note: string | null; // AI 修正案の説明
  revising: boolean;
  saving: boolean;
}

export default function SourceEntriesViewer({
  title,
  api,
  onState,
  onClose,
}: Props) {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 開いているエントリ id → 編集ドラフト
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  useEffect(() => {
    api.list().then((r) => {
      if ("error" in r) setError(r.error);
      else setEntries(r.entries);
    });
    // ビューアを開いたときに 1 回だけ読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEditor = (e: KnowledgeEntry) =>
    setDrafts((prev) => ({
      ...prev,
      [e.id]: {
        title: e.title,
        content: e.content,
        common: e.common,
        instruction: "",
        note: null,
        revising: false,
        saving: false,
      },
    }));

  const closeEditor = (id: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const patchDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const revise = async (id: string) => {
    const draft = drafts[id];
    if (!draft || draft.revising || draft.instruction.trim() === "") return;
    setError(null);
    patchDraft(id, { revising: true, note: null });
    const r = await api.revise(id, draft.instruction);
    if ("error" in r) {
      setError(r.error);
      patchDraft(id, { revising: false });
      return;
    }
    patchDraft(id, {
      title: r.title,
      content: r.content,
      common: r.common,
      note: r.note,
      revising: false,
    });
  };

  const save = async (id: string) => {
    const draft = drafts[id];
    if (!draft || draft.saving) return;
    setError(null);
    patchDraft(id, { saving: true });
    const r = await api.save(id, {
      title: draft.title,
      content: draft.content,
      common: draft.common,
    });
    if ("error" in r) {
      setError(r.error);
      patchDraft(id, { saving: false });
      return;
    }
    onState(r);
    setEntries((prev) =>
      (prev ?? []).map((e) =>
        e.id === id
          ? { ...e, title: draft.title, content: draft.content, common: draft.common, edited: true }
          : e,
      ),
    );
    closeEditor(id);
  };

  const remove = async (e: KnowledgeEntry) => {
    if (!window.confirm(`知識「${e.title}」を削除しますか?`)) return;
    setError(null);
    const r = await api.remove(e.id);
    if ("error" in r) {
      setError(r.error);
      return;
    }
    onState(r);
    setEntries((prev) => (prev ?? []).filter((x) => x.id !== e.id));
    closeEditor(e.id);
  };

  return (
    <div className="context-viewer-backdrop" onClick={onClose}>
      <div className="context-viewer" onClick={(ev) => ev.stopPropagation()}>
        <div className="context-viewer-header">
          <span>{title} からの抽出結果</span>
          <button className="context-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="entries-body">
          {error && <div className="context-error">⚠️ {error}</div>}
          {entries === null && !error && <div className="context-empty">読み込み中…</div>}
          {entries?.length === 0 && (
            <div className="context-empty">抽出されたエントリがありません。</div>
          )}
          {entries?.map((e) => {
            const draft = drafts[e.id];
            return (
              <div key={e.id} className="entry-item">
                <div className="entry-head">
                  <span className="entry-category">
                    {CATEGORY_LABELS[e.category] ?? e.category}
                  </span>
                  {e.common && <span className="entry-badge" title="業務横断の共通知識">🌐 共通</span>}
                  {e.edited && <span className="entry-badge" title="人が直した知識(再抽出でも上書きされない)">✍️ 修正済み</span>}
                  <span className="entry-title">{e.title}</span>
                  <span className="entry-ops">
                    {!draft && (
                      <button className="entry-edit" title="AI と協働で直す" onClick={() => openEditor(e)}>
                        ✏️
                      </button>
                    )}
                    <button className="entry-delete" title="このエントリを削除" onClick={() => remove(e)}>
                      ×
                    </button>
                  </span>
                </div>
                {!draft && <pre className="entry-content">{e.content}</pre>}
                {draft && (
                  <div className="entry-editor">
                    <input
                      type="text"
                      value={draft.title}
                      onChange={(ev) => patchDraft(e.id, { title: ev.target.value })}
                    />
                    <textarea
                      rows={5}
                      value={draft.content}
                      onChange={(ev) => patchDraft(e.id, { content: ev.target.value })}
                    />
                    <div className="entry-revise">
                      <textarea
                        rows={2}
                        placeholder="AI への修正指示(例: 閾値が違う。正しくは2億円 / これは全社共通のはず)"
                        value={draft.instruction}
                        onChange={(ev) => patchDraft(e.id, { instruction: ev.target.value })}
                      />
                      <button
                        className="entry-revise-btn"
                        disabled={draft.revising || draft.instruction.trim() === ""}
                        onClick={() => revise(e.id)}
                      >
                        {draft.revising ? "AI が原文を確認中…" : "✨ AI 修正案"}
                      </button>
                    </div>
                    {draft.note && <div className="entry-note">💡 {draft.note}</div>}
                    <div className="entry-editor-actions">
                      <button className="entry-cancel" onClick={() => closeEditor(e.id)}>
                        キャンセル
                      </button>
                      <button
                        className="entry-save"
                        disabled={draft.saving || draft.title.trim() === "" || draft.content.trim() === ""}
                        onClick={() => save(e.id)}
                      >
                        {draft.saving ? "保存中…" : "保存"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
