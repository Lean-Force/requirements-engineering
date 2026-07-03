"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

// 付箋(行動 / ストーリー)編集モーダル。Cmd/Ctrl+Enter 保存 / Esc 取消。空で保存すると削除。
// 確定(fix)中は本文編集・削除を無効化する(先に確定を解除する)。
// PanZoom の transform の影響を受けないよう body へポータルで出す。
export default function CardEditModal({
  kind,
  initial,
  initialFixed,
  color,
  onCommit,
  onCancel,
}: {
  kind: "action" | "story";
  initial: string;
  initialFixed: boolean;
  color: { bg: string; border: string };
  onCommit: (text: string, fixed: boolean) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [fixed, setFixed] = useState(initialFixed);
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
          <button
            className="story-modal-delete"
            onClick={() => onCommit("", false)}
            disabled={fixed}
          >
            削除
          </button>
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
