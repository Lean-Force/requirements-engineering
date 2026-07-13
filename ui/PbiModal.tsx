"use client";

// PBI 化(EARS 記法)の結果モーダル。開いた時点で生成を開始し、
// タイトル / ユーザーストーリー / 背景 / EARS 要求一覧 / 未決事項を表示する。
// 「Markdown をコピー」でそのままバックログツールへ貼れる。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface PbiRequirement {
  pattern: string;
  patternLabel: string;
  conforms: boolean;
  text: string;
}

interface Pbi {
  title: string;
  userStory: string;
  background: string;
  requirements: PbiRequirement[];
  openQuestions: string[];
}

interface Props {
  apiBase: string;
  storyId: string;
  storyText: string;
  onClose: () => void;
}

function toMarkdown(pbi: Pbi): string {
  const lines = [
    `# ${pbi.title}`,
    "",
    "## ユーザーストーリー",
    pbi.userStory,
    "",
    "## 背景",
    pbi.background,
    "",
    "## 要求(EARS)",
    ...pbi.requirements.map((r) => `- [${r.patternLabel}] ${r.text}`),
  ];
  if (pbi.openQuestions.length > 0) {
    lines.push("", "## 未決事項", ...pbi.openQuestions.map((q) => `- ${q}`));
  }
  return lines.join("\n");
}

export default function PbiModal({ apiBase, storyId, storyText, onClose }: Props) {
  const [pbi, setPbi] = useState<Pbi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/pbi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storyId }),
    })
      .then(async (r) => {
        const data = (await r.json()) as Pbi & { error?: string };
        if (cancelled) return;
        if (!r.ok) setError(data.error ?? "PBI の生成に失敗しました");
        else setPbi(data);
      })
      .catch((e) => {
        if (!cancelled) setError(`通信に失敗しました (${String(e)})`);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, storyId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = () => {
    if (!pbi) return;
    void navigator.clipboard.writeText(toMarkdown(pbi)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return createPortal(
    <div className="discussion-overlay" onClick={onClose}>
      <div className="discussion-modal pbi-modal" onClick={(e) => e.stopPropagation()}>
        <div className="discussion-header">
          <h3>📋 PBI 化(EARS): {storyText}</h3>
          <button className="discussion-close" onClick={onClose} title="閉じる(Esc)">×</button>
        </div>

        {!pbi && !error && (
          <p className="pbi-loading">
            AI が PBI を生成中…(ドメイン知識を読むため数十秒かかることがあります)
          </p>
        )}
        {error && <p className="story-modal-error">⚠️ {error}</p>}

        {pbi && (
          <>
            <h4 className="pbi-title">{pbi.title}</h4>
            <section>
              <h5>ユーザーストーリー</h5>
              <p>{pbi.userStory}</p>
            </section>
            <section>
              <h5>背景</h5>
              <p>{pbi.background}</p>
            </section>
            <section>
              <h5>要求(EARS)</h5>
              <ul className="pbi-requirements">
                {pbi.requirements.map((r, i) => (
                  <li key={i} className={r.conforms ? "" : "nonconforming"}>
                    <span className="pbi-pattern">{r.patternLabel}</span>
                    {r.text}
                  </li>
                ))}
              </ul>
            </section>
            {pbi.openQuestions.length > 0 && (
              <section>
                <h5>未決事項(要求化していない)</h5>
                <ul className="pbi-open-questions">
                  {pbi.openQuestions.map((q, i) => (
                    <li key={i}>💬 {q}</li>
                  ))}
                </ul>
              </section>
            )}
            <div className="pbi-actions">
              <button className="pbi-copy" onClick={copy}>
                {copied ? "✓ コピーしました" : "Markdown をコピー"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
