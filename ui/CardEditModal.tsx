"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import type { RefineResponse } from "@/contracts";

// 付箋(行動 / ストーリー)編集モーダル。Cmd/Ctrl+Enter 保存 / Esc 取消。空で保存すると削除。
// 確定(fix)中は本文編集・削除を無効化する(先に確定を解除する)。
// ✨ AI 校正: 現在の本文の推敲案(推奨形式・ドメイン知識の用語に沿う)を提示し、ワンクリックで差し替える。
// PanZoom の transform の影響を受けないよう body へポータルで出す。
export default function CardEditModal({
  kind,
  initial,
  initialFixed,
  color,
  onCommit,
  onCancel,
  onRefine,
}: {
  kind: "action" | "story";
  initial: string;
  initialFixed: boolean;
  color: { bg: string; border: string };
  onCommit: (text: string, fixed: boolean) => void;
  onCancel: () => void;
  /** AI 校正(未指定ならボタン非表示)。エラー時は文字列を返す */
  onRefine?: (text: string) => Promise<RefineResponse | { error: string }>;
}) {
  const [text, setText] = useState(initial);
  const [fixed, setFixed] = useState(initialFixed);
  const [refining, setRefining] = useState(false);
  const [proposal, setProposal] = useState<RefineResponse | null>(null);
  const [refineError, setRefineError] = useState<string | null>(null);
  const title = kind === "action" ? "行動を編集" : "ストーリーを編集";
  const placeholder =
    kind === "action"
      ? "行動(例: 商品を受け取る)"
      : "ストーリー(例: 店員は…したい。なぜなら…だからだ。)";
  const recommendHint =
    kind === "action"
      ? "短く具体的な行動表現を推奨(例:「レジに立つ」)。⌘/Ctrl + Enter で保存"
      : "「(アクター)は〜したい。なぜなら〜だからだ。」の形を推奨。⌘/Ctrl + Enter で保存";
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onCommit(text, fixed);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const refine = async () => {
    if (!onRefine || refining || text.trim() === "") return;
    setRefining(true);
    setRefineError(null);
    setProposal(null);
    const result = await onRefine(text);
    if ("error" in result) setRefineError(result.error);
    else setProposal(result);
    setRefining(false);
  };

  return createPortal(
    <div className="story-modal-backdrop" onClick={onCancel}>
      <div className="story-modal" onClick={(e) => e.stopPropagation()}>
        <div className="story-modal-header">
          <span>{title}</span>
          <button className="story-modal-close" onClick={onCancel} aria-label="閉じる">
            ×
          </button>
        </div>
        <textarea
          className="story-modal-input"
          style={{ background: color.bg, borderColor: color.border }}
          autoFocus
          rows={5}
          value={text}
          disabled={fixed}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {proposal && (
          <div className="story-modal-proposal">
            <div className="story-modal-proposal-title">✨ AI の推敲案</div>
            <div className="story-modal-proposal-text">{proposal.suggestion}</div>
            <div className="story-modal-proposal-note">{proposal.note}</div>
            <div className="story-modal-proposal-actions">
              <button
                className="story-modal-proposal-apply"
                onClick={() => {
                  setText(proposal.suggestion);
                  setProposal(null);
                }}
              >
                この案に差し替え
              </button>
              <button
                className="story-modal-proposal-dismiss"
                onClick={() => setProposal(null)}
              >
                使わない
              </button>
            </div>
          </div>
        )}
        {refineError && <div className="story-modal-error">⚠️ {refineError}</div>}
        <label className="story-modal-fixed">
          <input
            type="checkbox"
            checked={fixed}
            onChange={(e) => setFixed(e.target.checked)}
          />
          🔒 確定(チーム合意済み)— AI もメンバーも変更・削除できなくなる
        </label>
        <div className="story-modal-hint">
          {fixed
            ? "確定中は本文の編集と削除ができません。変更するには先に確定を外してください。"
            : recommendHint}
        </div>
        <div className="story-modal-actions">
          <div className="story-modal-actions-left">
            <button
              className="story-modal-delete"
              onClick={() => onCommit("", false)}
              disabled={fixed}
            >
              削除
            </button>
            {onRefine && (
              <button
                className="story-modal-refine"
                onClick={refine}
                disabled={fixed || refining || text.trim() === ""}
                title="推奨形式・ドメイン知識の用語に沿った推敲案を AI に出してもらう"
              >
                {refining ? "AI が推敲中…" : "✨ AI 校正"}
              </button>
            )}
          </div>
          <div className="story-modal-actions-right">
            <button className="story-modal-cancel" onClick={onCancel}>
              キャンセル
            </button>
            <button className="story-modal-save" onClick={() => onCommit(text, fixed)}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
