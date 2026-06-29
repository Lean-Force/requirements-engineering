"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/contracts";

interface Props {
  messages: ChatMessage[];
  loading: boolean;
  onSend: (text: string) => void;
  onClear?: () => void;
}

export default function ChatPanel({ messages, loading, onSend, onClear }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新しいメッセージが来たら一番下へスクロール
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const submit = () => {
    const text = input.trim();
    if (!text || loading) return;
    onSend(text);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter で送信
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>AI チャット</span>
        {onClear && messages.length > 0 && (
          <button className="chat-clear" onClick={onClear} disabled={loading}>
            会話をクリア
          </button>
        )}
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-intro">
            プロダクトの要件を自然言語で伝えてください。AI が User Story Map
            の要素に分解し、右のボードに反映します。
            <ul>
              <li>「ECサイトを作りたい。商品検索とカート、決済機能が必要」</li>
              <li>「決済にクレジットカードとコンビニ払いを追加して」</li>
              <li>「カート機能を Release 2 に移して」</li>
            </ul>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "assistant" && m.content.startsWith("__error__:")) {
            return (
              <div key={i} className="msg error">
                {m.content.replace("__error__:", "⚠️ ")}
              </div>
            );
          }
          return (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
            </div>
          );
        })}

        {loading && <div className="typing">AI が整理しています…</div>}
      </div>

      <div className="chat-input">
        <textarea
          rows={3}
          value={input}
          placeholder="要件を入力(⌘/Ctrl + Enter で送信)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button onClick={submit} disabled={loading || !input.trim()}>
          送信
        </button>
      </div>
    </div>
  );
}
