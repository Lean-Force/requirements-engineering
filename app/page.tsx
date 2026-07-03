"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Board from "@/ui/Board";
import PanZoom from "@/ui/PanZoom";
import ChatPanel from "@/ui/ChatPanel";
import HistoryPanel from "@/ui/HistoryPanel";
import ContextPanel from "@/ui/ContextPanel";
import { emptyStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type {
  BoardEvent,
  ChatMessage,
  ChatResponse,
  ContextDocMeta,
  SessionState,
  StoryMapVersionMeta,
} from "@/contracts";

export default function Home() {
  const [storyMap, setStoryMap] = useState<StoryMap>(emptyStoryMap());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [versions, setVersions] = useState<StoryMapVersionMeta[]>([]);
  const [contexts, setContexts] = useState<ContextDocMeta[]>([]);
  const [loading, setLoading] = useState(false);
  // 他のメンバーの AI ターンが進行中(SSE の chat:start / chat:end で更新)
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showContexts, setShowContexts] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // ボードの 📌 で選んだストーリー(次のチャット送信の対象として AI に渡す)
  const [selectedStory, setSelectedStory] = useState<{ storyId: string; text: string } | null>(null);

  // ボード編集の保存はまとめて行う(D&D 連打でリクエストが溢れないよう debounce)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // SSE 由来の再取得が自分の進行中の操作を上書きしないためのガード
  const loadingRef = useRef(false);

  // 初回ロード:保存済みセッション + コンテキスト一覧を取得
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

    fetch("/api/contexts")
      .then((r) => r.json())
      .then((docs: ContextDocMeta[]) => setContexts(docs))
      .catch(() => {
        /* 取得失敗時は空のまま */
      });
  }, []);

  // 他メンバーの変更を取り込む(自分のチャット送信中・ボード編集の保存待ち中は控える)
  const refetchSession = useCallback(() => {
    if (loadingRef.current || saveTimer.current) return;
    fetch("/api/session")
      .then((r) => r.json())
      .then((s: SessionState) => {
        setStoryMap(s.storyMap);
        setMessages(s.messages ?? []);
        setVersions(s.versions ?? []);
      })
      .catch(() => {
        /* 失敗時は手元の状態のまま(次のイベントで再試行される) */
      });
  }, []);

  // SSE でボードの変更を購読(EventSource は切断時に自動再接続する)
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      let event: BoardEvent;
      try {
        event = JSON.parse(e.data) as BoardEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case "storymap":
          refetchSession();
          break;
        case "chat:start":
          setRemoteBusy(true);
          break;
        case "chat:end":
          setRemoteBusy(false);
          refetchSession();
          break;
        case "contexts":
          fetch("/api/contexts")
            .then((r) => r.json())
            .then((docs: ContextDocMeta[]) => setContexts(docs))
            .catch(() => {
              /* 失敗時は手元の一覧のまま */
            });
          break;
      }
    };
    return () => source.close();
  }, [refetchSession]);

  // チャット送信 → AI がマップを更新して返す
  const sendMessage = useCallback(
    async (text: string) => {
      // 📌 選択中のストーリーがあれば、対象として明示した上で送る
      // (会話履歴にも残るので、チームは「どの付箋への指示だったか」を追える)
      const content = selectedStory
        ? `【対象ストーリー】「${selectedStory.text}」(id: ${selectedStory.storyId})\n\n${text}`
        : text;
      const userMsg: ChatMessage = { role: "user", content };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setSelectedStory(null);
      setLoading(true);
      loadingRef.current = true;

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
        loadingRef.current = false;
      }
    },
    [messages, storyMap, selectedStory],
  );

  // ボードでの直接編集(D&D・追加・削除)→ debounce して保存
  const updateStoryMap = useCallback((next: StoryMap) => {
    setStoryMap(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
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
    setShowContexts(false);
    fetch("/api/versions")
      .then((r) => r.json())
      .then((v: StoryMapVersionMeta[]) => setVersions(v))
      .catch(() => {
        /* 失敗時は手元の一覧のまま */
      });
  }, []);

  const openContexts = useCallback(() => {
    setShowContexts(true);
    setShowHistory(false);
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

  // コンテキスト(参照資料)の操作
  const uploadContexts = useCallback(async (files: FileList): Promise<string | null> => {
    const form = new FormData();
    for (const file of Array.from(files)) form.append("files", file);
    try {
      const res = await fetch("/api/contexts", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) return (data.error as string) ?? "アップロードに失敗しました";
      setContexts(data as ContextDocMeta[]);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "アップロードに失敗しました";
    }
  }, []);

  const toggleContext = useCallback(async (id: string, enabled: boolean) => {
    // 先に画面へ反映し、失敗したらサーバー状態に合わせ直す
    setContexts((prev) => prev.map((d) => (d.id === id ? { ...d, enabled } : d)));
    try {
      const res = await fetch(`/api/contexts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) setContexts((await res.json()) as ContextDocMeta[]);
    } catch {
      /* SSE の contexts イベントで整合される */
    }
  }, []);

  const deleteContextDoc = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/contexts/${id}`, { method: "DELETE" });
      if (res.ok) setContexts((await res.json()) as ContextDocMeta[]);
    } catch {
      /* SSE の contexts イベントで整合される */
    }
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
          <div className="header-buttons">
            <button className="context-open" onClick={openContexts}>
              コンテキスト{contexts.length > 0 ? `(${contexts.filter((d) => d.enabled).length})` : ""}
            </button>
            <button className="history-toggle" onClick={openHistory}>
              版履歴{versions.length > 0 ? `(${versions.length})` : ""}
            </button>
          </div>
        </header>
        <div className="board-scroll">
          {ready ? (
            <PanZoom>
              <Board
                storyMap={storyMap}
                onChange={updateStoryMap}
                onPickStory={setSelectedStory}
              />
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
        {showContexts && (
          <ContextPanel
            docs={contexts}
            onUpload={uploadContexts}
            onToggle={toggleContext}
            onDelete={deleteContextDoc}
            onClose={() => setShowContexts(false)}
          />
        )}
      </div>
      <ChatPanel
        messages={messages}
        loading={loading}
        remoteBusy={remoteBusy}
        selectedStory={selectedStory}
        onClearSelection={() => setSelectedStory(null)}
        onSend={sendMessage}
        onClear={clearChat}
      />
    </div>
  );
}
