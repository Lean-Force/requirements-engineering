"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Board from "@/ui/Board";
import PanZoom from "@/ui/PanZoom";
import ChatPanel from "@/ui/ChatPanel";
import HistoryPanel from "@/ui/HistoryPanel";
import { emptyStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type {
  ChatMessage,
  ChatResponse,
  SessionState,
  StoryMapVersionMeta,
} from "@/contracts";

export default function Home() {
  const [storyMap, setStoryMap] = useState<StoryMap>(emptyStoryMap());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [versions, setVersions] = useState<StoryMapVersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // ボード編集の保存はまとめて行う(D&D 連打でリクエストが溢れないよう debounce)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初回ロード:保存済みセッション(マップ + 会話 + 版一覧)を取得
  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((s: SessionState) => {
        setStoryMap(s.storyMap);
        setMessages(s.messages ?? []);
        setVersions(s.versions ?? []);
      })
      .catch(() => {
        /* 取得失敗時は初期状態のまま */
      })
      .finally(() => setReady(true));
  }, []);

  // チャット送信 → AI がマップを更新して返す
  const sendMessage = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { role: "user", content: text };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setLoading(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextMessages, storyMap }),
        });
        const data = await res.json();

        if (!res.ok) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `__error__:${data.error ?? "エラーが発生しました"}` },
          ]);
          return;
        }

        const { reply, storyMap: updated, versions: nextVersions } = data as ChatResponse;
        setStoryMap(updated);
        setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
        if (nextVersions) setVersions(nextVersions);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `__error__:通信に失敗しました (${msg})` },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [messages, storyMap],
  );

  // ボードでの直接編集(D&D・追加・削除)→ debounce して保存
  const updateStoryMap = useCallback((next: StoryMap) => {
    setStoryMap(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/storymap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {
        /* 保存失敗は致命的でないため握りつぶす */
      });
    }, 700);
  }, []);

  // 履歴パネルを開くたびに最新の版一覧へ更新(ボード編集も反映される)
  const openHistory = useCallback(() => {
    setShowHistory(true);
    fetch("/api/versions")
      .then((r) => r.json())
      .then((v: StoryMapVersionMeta[]) => setVersions(v))
      .catch(() => {
        /* 失敗時は手元の一覧のまま */
      });
  }, []);

  // 指定の版に復元
  const restoreVersion = useCallback(async (id: string) => {
    setRestoringId(id);
    try {
      const res = await fetch("/api/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (res.ok) {
        setStoryMap(data.storyMap as StoryMap);
        setVersions(data.versions as StoryMapVersionMeta[]);
      }
    } catch {
      /* 失敗時は何もしない */
    } finally {
      setRestoringId(null);
    }
  }, []);

  // 会話をクリア(マップ・版履歴は保持)
  const clearChat = useCallback(async () => {
    setMessages([]);
    await fetch("/api/messages", { method: "DELETE" }).catch(() => {
      /* 失敗は握りつぶす */
    });
  }, []);

  return (
    <div className="app">
      <div className="board-area">
        <header className="app-header">
          <div>
            <h1>USM AI Chat</h1>
            <span className="sub">
              AI と対話しながら User Story Map を構築・整理
            </span>
          </div>
          <button className="history-toggle" onClick={openHistory}>
            版履歴{versions.length > 0 ? `(${versions.length})` : ""}
          </button>
        </header>
        <div className="board-scroll">
          {ready ? (
            <PanZoom>
              <Board storyMap={storyMap} onChange={updateStoryMap} />
            </PanZoom>
          ) : (
            <div className="board-empty">読み込み中…</div>
          )}
        </div>
        {showHistory && (
          <HistoryPanel
            versions={versions}
            restoringId={restoringId}
            onRestore={restoreVersion}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>
      <ChatPanel
        messages={messages}
        loading={loading}
        onSend={sendMessage}
        onClear={clearChat}
      />
    </div>
  );
}
