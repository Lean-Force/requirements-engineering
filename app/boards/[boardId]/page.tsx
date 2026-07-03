"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Board from "@/ui/Board";
import PanZoom from "@/ui/PanZoom";
import ChatPanel from "@/ui/ChatPanel";
import HistoryPanel from "@/ui/HistoryPanel";
import ContextPanel from "@/ui/ContextPanel";
import BoardSwitcher from "@/ui/BoardSwitcher";
import { emptyStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type {
  BoardEvent,
  BoardMeta,
  ChatMessage,
  ChatResponse,
  KnowledgeState,
  SessionState,
  StoryMapVersionMeta,
} from "@/contracts";

const EMPTY_KNOWLEDGE: KnowledgeState = { sources: [], categories: [] };

interface Props {
  params: { boardId: string };
}

export default function BoardPage({ params }: Props) {
  const { boardId } = params;
  const api = `/api/boards/${boardId}`;

  const [board, setBoard] = useState<BoardMeta | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [storyMap, setStoryMap] = useState<StoryMap>(emptyStoryMap());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [versions, setVersions] = useState<StoryMapVersionMeta[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeState>(EMPTY_KNOWLEDGE);
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
  // ?bootstrap=1 付きで開かれたら、取り込み済み知識から叩き台を自動生成する
  const bootstrapRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("bootstrap") === "1") {
      bootstrapRef.current = true;
      // リロードで再生成されないよう URL からフラグを消す
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // 次回 / を開いたときにこのボードへ直行できるよう控える
  useEffect(() => {
    try {
      localStorage.setItem("usm:lastBoard", boardId);
    } catch {
      /* プライベートモード等で失敗しても支障なし */
    }
  }, [boardId]);

  // 初回ロード:保存済みセッション + 知識ベースを取得
  useEffect(() => {
    fetch(`${api}/session`)
      .then(async (r) => {
        if (!r.ok) {
          setNotFound(true);
          return null;
        }
        return (await r.json()) as SessionState & { board: BoardMeta };
      })
      .then((s) => {
        if (!s) return;
        setBoard(s.board);
        setStoryMap(s.storyMap);
        setMessages(s.messages ?? []);
        setVersions(s.versions ?? []);
      })
      .catch(() => {
        /* 取得失敗時は初期状態のまま */
      })
      .finally(() => setReady(true));

    fetch(`${api}/contexts`)
      .then((r) => r.json())
      .then((state: KnowledgeState) => setKnowledge(state))
      .catch(() => {
        /* 取得失敗時は空のまま */
      });
  }, [api]);

  // 他メンバーの変更を取り込む(自分のチャット送信中・ボード編集の保存待ち中は控える)
  const refetchSession = useCallback(() => {
    if (loadingRef.current || saveTimer.current) return;
    fetch(`${api}/session`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: (SessionState & { board: BoardMeta }) | null) => {
        if (!s) return;
        setBoard(s.board);
        setStoryMap(s.storyMap);
        setMessages(s.messages ?? []);
        setVersions(s.versions ?? []);
      })
      .catch(() => {
        /* 失敗時は手元の状態のまま(次のイベントで再試行される) */
      });
  }, [api]);

  // SSE でボードの変更を購読(EventSource は切断時に自動再接続する)
  useEffect(() => {
    const source = new EventSource(`${api}/events`);
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
          fetch(`${api}/contexts`)
            .then((r) => r.json())
            .then((state: KnowledgeState) => setKnowledge(state))
            .catch(() => {
              /* 失敗時は手元の一覧のまま */
            });
          break;
      }
    };
    return () => source.close();
  }, [api, refetchSession]);

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
        const res = await fetch(`${api}/chat`, {
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
    [api, messages, storyMap, selectedStory],
  );

  // 資料つきで作成されたボード: 読み込み完了後に一度だけ叩き台の生成を AI へ依頼する
  useEffect(() => {
    if (!ready || !bootstrapRef.current) return;
    bootstrapRef.current = false;
    if (messages.length === 0) {
      sendMessage(
        "アップロードした資料から抽出されたドメイン知識(用語・アクター・業務フロー・データ定義・背景)をもとに、この業務の User Story Map の叩き台を作成してください。",
      );
    }
  }, [ready, messages.length, sendMessage]);

  // ボードでの直接編集(D&D・追加・削除)→ debounce して保存
  const updateStoryMap = useCallback(
    (next: StoryMap) => {
      setStoryMap(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        fetch(`${api}/storymap`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        }).catch(() => {
          /* 保存失敗は致命的でないため握りつぶす */
        });
      }, 700);
    },
    [api],
  );

  // 履歴パネルを開くたびに最新の版一覧へ更新(ボード編集も反映される)
  const openHistory = useCallback(() => {
    setShowHistory(true);
    setShowContexts(false);
    fetch(`${api}/versions`)
      .then((r) => r.json())
      .then((v: StoryMapVersionMeta[]) => setVersions(v))
      .catch(() => {
        /* 失敗時は手元の一覧のまま */
      });
  }, [api]);

  const openContexts = useCallback(() => {
    setShowContexts(true);
    setShowHistory(false);
  }, []);

  // 指定の版に復元
  const restoreVersion = useCallback(
    async (id: string) => {
      setRestoringId(id);
      try {
        const res = await fetch(`${api}/versions`, {
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
    },
    [api],
  );

  // 会話をクリア(マップ・版履歴は保持)
  const clearChat = useCallback(async () => {
    setMessages([]);
    await fetch(`${api}/messages`, { method: "DELETE" }).catch(() => {
      /* 失敗は握りつぶす */
    });
  }, [api]);

  // ドメイン知識(コンテキスト)の操作
  const uploadContexts = useCallback(
    async (files: FileList, common: boolean): Promise<string | null> => {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("files", file);
      if (common) form.append("common", "1");
      try {
        const res = await fetch(`${api}/contexts`, { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) return (data.error as string) ?? "アップロードに失敗しました";
        setKnowledge(data as KnowledgeState);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "アップロードに失敗しました";
      }
    },
    [api],
  );

  const toggleContext = useCallback(
    async (id: string, enabled: boolean) => {
      // 先に画面へ反映し、失敗したらサーバー状態に合わせ直す
      setKnowledge((prev) => ({
        ...prev,
        sources: prev.sources.map((s) => (s.id === id ? { ...s, enabled } : s)),
      }));
      try {
        const res = await fetch(`${api}/contexts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (res.ok) setKnowledge((await res.json()) as KnowledgeState);
      } catch {
        /* SSE の contexts イベントで整合される */
      }
    },
    [api],
  );

  const deleteContextDoc = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`${api}/contexts/${id}`, { method: "DELETE" });
        if (res.ok) setKnowledge((await res.json()) as KnowledgeState);
      } catch {
        /* SSE の contexts イベントで整合される */
      }
    },
    [api],
  );

  if (notFound) {
    return (
      <div className="board-missing">
        <p>指定のボードが見つかりません。</p>
        <Link href="/">ボード一覧へ戻る</Link>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="board-area">
        <header className="app-header">
          <div className="header-title">
            <BoardSwitcher current={board} />
            <span className="sub">
              AI と対話しながら User Story Map を構築・整理
            </span>
          </div>
          <div className="header-buttons">
            <button className="context-open" onClick={openContexts}>
              ドメイン知識
              {knowledge.sources.length > 0
                ? `(${knowledge.categories.reduce((n, c) => n + c.count, 0)})`
                : ""}
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
            knowledge={knowledge}
            boardName={board?.name ?? "このボード"}
            apiBase={api}
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
