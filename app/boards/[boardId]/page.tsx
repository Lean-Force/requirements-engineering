"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Board, { type PickTarget } from "@/ui/Board";
import PanZoom from "@/ui/PanZoom";
import ChatPanel from "@/ui/ChatPanel";
import HistoryPanel from "@/ui/HistoryPanel";
import ContextPanel from "@/ui/ContextPanel";
import BoardSwitcher from "@/ui/BoardSwitcher";
import { useBoardEvents } from "@/ui/hooks/useBoardEvents";
import { useUndoRedo } from "@/ui/hooks/useUndoRedo";
import { emptyStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type {
  BoardMeta,
  ChatMessage,
  ChatResponse,
  KnowledgeState,
  RefineRequest,
  RefineResponse,
  SessionState,
  StoryMapVersionMeta,
} from "@/contracts";

const EMPTY_KNOWLEDGE: KnowledgeState = { sources: [], categories: [], conflicts: [], proposals: [] };

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
  // 会話パネルの折りたたみ(ボードを広く使う。状態はブラウザに保持)
  const [chatCollapsed, setChatCollapsed] = useState(false);
  useEffect(() => {
    setChatCollapsed(localStorage.getItem("usm-chat-collapsed") === "1");
  }, []);
  const toggleChat = useCallback(() => {
    setChatCollapsed((prev) => {
      localStorage.setItem("usm-chat-collapsed", prev ? "0" : "1");
      return !prev;
    });
  }, []);
  const [showContexts, setShowContexts] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // ボードの 📌 で選んだ付箋(ストーリー / 行動。次のチャット送信の対象として AI に渡す)
  const [selectedTarget, setSelectedTarget] = useState<PickTarget | null>(null);

  // ボード編集の保存はまとめて行う(D&D 連打でリクエストが溢れないよう debounce)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SSE 由来の再取得が自分の進行中の操作を上書きしないためのガード
  const loadingRef = useRef(false);
  // ?bootstrap=1 付きで開かれたら、取り込み済み知識から叩き台を自動生成する
  const router = useRouter();
  const bootstrapRef = useRef(false);

  // マウント時だけでなく、SPA 内のボード間遷移(コンポーネント再利用)でも
  // ?bootstrap=1 を拾えるよう boardId の変化で再評価する
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("bootstrap") === "1") {
      bootstrapRef.current = true;
      // リロードで再生成されないよう URL からフラグを消す
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [boardId]);

  // 次回 / を開いたときにこのボードへ直行できるよう控える
  useEffect(() => {
    try {
      localStorage.setItem("usm:lastBoard", boardId);
    } catch {
      /* プライベートモード等で失敗しても支障なし */
    }
  }, [boardId]);

  // 初回ロード:保存済みセッション + 知識ベースを取得。
  // ボード間遷移(コンポーネント再利用)でも読み直すため、開始時に ready を戻す
  // (叩き台の自動生成はロード完了後に発火させる)。
  useEffect(() => {
    setReady(false);
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
        setVersions(s.versions ?? []);
        // 自分の AI ターンが進行中なら、古いセッションで会話とマップを
        // 上書きしない(StrictMode の二重実行や遅延レスポンス対策)
        if (!loadingRef.current) {
          setStoryMap(s.storyMap);
          setMessages(s.messages ?? []);
        }
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

  // マップを反映して debounce 保存する(undo 履歴には触れない)
  const applyMap = useCallback(
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

  // Undo / Redo(⌘Z / ⇧⌘Z)。ボード直接編集のみ対象。
  const { track, clear: clearHistory } = useUndoRedo(storyMap, applyMap);

  // ボードでの直接編集(D&D・追加・削除)→ undo 履歴へ積んで保存
  const updateStoryMap = useCallback(
    (next: StoryMap) => {
      track();
      applyMap(next);
    },
    [track, applyMap],
  );

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
        clearHistory();
      })
      .catch(() => {
        /* 失敗時は手元の状態のまま(次のイベントで再試行される) */
      });
  }, [api, clearHistory]);

  // SSE でボードの変更を購読(薄い通知 → 再取得)
  useBoardEvents(api, {
    onStorymap: refetchSession,
    onChatStart: () => setRemoteBusy(true),
    onChatEnd: () => {
      setRemoteBusy(false);
      refetchSession();
    },
    onContexts: () => {
      fetch(`${api}/contexts`)
        .then((r) => r.json())
        .then((state: KnowledgeState) => setKnowledge(state))
        .catch(() => {
          /* 失敗時は手元の一覧のまま */
        });
    },
  });

  // チャット送信の共通コア(nextMessages の末尾はユーザー発言)
  const postChat = useCallback(
    async (nextMessages: ChatMessage[]) => {
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

        const { reply, storyMap: updated, versions: nextVersions, usedSkills } = data as ChatResponse;
        setStoryMap(updated);
        clearHistory(); // AI がマップを更新したので、それ以前へは ⌘Z で戻さない
        setMessages((prev) => [...prev, { role: "assistant", content: reply, usedSkills }]);
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
    [api, storyMap, clearHistory],
  );

  // チャット送信 → AI がマップを更新して返す
  const sendMessage = useCallback(
    async (text: string) => {
      // 📌 選択中の付箋があれば、対象として明示した上で送る
      // (会話履歴にも残るので、チームは「どの付箋への指示だったか」を追える)
      const content = selectedTarget
        ? `【対象${selectedTarget.kind === "story" ? "ストーリー" : "行動"}】「${selectedTarget.text}」(id: ${selectedTarget.id})\n\n${text}`
        : text;
      const userMsg: ChatMessage = { role: "user", content };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setSelectedTarget(null);
      await postChat(nextMessages);
    },
    [messages, selectedTarget, postChat],
  );

  // 失敗したターンの再試行: 末尾のエラーメッセージを取り除き、同じ会話で再送する
  const retryLast = useCallback(() => {
    const trimmed = [...messages];
    while (
      trimmed.length > 0 &&
      trimmed[trimmed.length - 1].role === "assistant" &&
      trimmed[trimmed.length - 1].content.startsWith("__error__:")
    ) {
      trimmed.pop();
    }
    if (trimmed.length === 0 || trimmed[trimmed.length - 1].role !== "user") return;
    setMessages(trimmed);
    postChat(trimmed);
  }, [messages, postChat]);

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
          clearHistory();
        }
      } catch {
        /* 失敗時は何もしない */
      } finally {
        setRestoringId(null);
      }
    },
    [api, clearHistory],
  );

  // 会話をクリア(マップ・版履歴は保持)
  const clearChat = useCallback(async () => {
    setMessages([]);
    await fetch(`${api}/messages`, { method: "DELETE" }).catch(() => {
      /* 失敗は握りつぶす */
    });
  }, [api]);

  // 付箋(行動 / ストーリー)の AI 校正(マップは変えない。提案を返すだけ)
  const refineCard = useCallback(
    async (req: RefineRequest): Promise<RefineResponse | { error: string }> => {
      try {
        const res = await fetch(`${api}/refine`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        });
        const data = await res.json();
        if (!res.ok) return { error: (data.error as string) ?? "校正に失敗しました" };
        return data as RefineResponse;
      } catch (e) {
        return { error: e instanceof Error ? e.message : "校正に失敗しました" };
      }
    },
    [api],
  );

  // ドメイン知識(コンテキスト)の操作
  const uploadContexts = useCallback(
    async (files: FileList): Promise<string | null> => {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("files", file);
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

  const reextractContext = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const res = await fetch(`${api}/contexts/${id}/reextract`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) return (data.error as string) ?? "再抽出に失敗しました";
        setKnowledge(data as KnowledgeState);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "再抽出に失敗しました";
      }
    },
    [api],
  );

  // 閲覧用 Markdown の取得(失敗時はエラーメッセージ文字列を返す = パネルはそのまま表示)
  const loadCategoryMarkdown = useCallback(
    async (category: string): Promise<string> => {
      try {
        const res = await fetch(`${api}/contexts/knowledge/${category}`);
        const data = await res.json();
        return res.ok
          ? (data.markdown as string)
          : `⚠️ ${data.error ?? "読み込みに失敗しました"}`;
      } catch {
        return "⚠️ 読み込みに失敗しました";
      }
    },
    [api],
  );

  // 矛盾を解決済みにする
  const dismissConflict = useCallback(
    async (conflictId: string): Promise<string | null> => {
      try {
        const res = await fetch(`${api}/contexts/conflicts/${conflictId}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) return (data.error as string) ?? "操作に失敗しました";
        setKnowledge(data as KnowledgeState);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "操作に失敗しました";
      }
    },
    [api],
  );

  // ボード作成提案の承認(作成 + 資料移動)→ 新ボードの叩き台生成へ遷移
  const acceptProposal = useCallback(
    async (proposalId: string): Promise<string | null> => {
      try {
        const res = await fetch(`${api}/contexts/proposals/${proposalId}/accept`, {
          method: "POST",
        });
        const data = await res.json();
        if (!res.ok) return (data.error as string) ?? "作成に失敗しました";
        const { board: created } = data as { board: BoardMeta };
        router.push(`/boards/${created.id}?bootstrap=1`);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "作成に失敗しました";
      }
    },
    [api, router],
  );

  const dismissProposal = useCallback(
    async (proposalId: string): Promise<string | null> => {
      try {
        const res = await fetch(`${api}/contexts/proposals/${proposalId}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) return (data.error as string) ?? "操作に失敗しました";
        setKnowledge(data as KnowledgeState);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "操作に失敗しました";
      }
    },
    [api],
  );

  // 資料 1 件のエントリ操作 API(一覧・AI 修正案・保存・削除)
  const entriesApiFor = useCallback(
    (sourceId: string) => {
      const base = `${api}/contexts/${sourceId}/entries`;
      const call = async (url: string, init?: RequestInit) => {
        try {
          const res = await fetch(url, init);
          const data = await res.json();
          return res.ok ? data : { error: (data.error as string) ?? "操作に失敗しました" };
        } catch (e) {
          return { error: e instanceof Error ? e.message : "操作に失敗しました" };
        }
      };
      return {
        list: () => call(base),
        revise: (entryId: string, instruction: string) =>
          call(`${base}/${entryId}/revise`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instruction }),
          }),
        save: (entryId: string, patch: unknown) =>
          call(`${base}/${entryId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }),
        remove: (entryId: string) => call(`${base}/${entryId}`, { method: "DELETE" }),
      };
    },
    [api],
  );

  const loadSourceMarkdown = useCallback(
    async (id: string): Promise<string> => {
      try {
        const res = await fetch(`${api}/contexts/${id}`);
        const data = await res.json();
        return res.ok
          ? (data.markdown as string)
          : `⚠️ ${data.error ?? "読み込みに失敗しました"}`;
      } catch {
        return "⚠️ 読み込みに失敗しました";
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
            <BoardSwitcher
              current={board}
              onCurrentRenamed={(name) =>
                setBoard((prev) => (prev ? { ...prev, name } : prev))
              }
            />
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
              Versions{versions.length > 0 ? `(${versions.length})` : ""}
            </button>
          </div>
        </header>
        <div className="board-scroll">
          {ready ? (
            <PanZoom>
              <Board
                storyMap={storyMap}
                onChange={updateStoryMap}
                onPickTarget={setSelectedTarget}
                onRefine={refineCard}
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
            onUpload={uploadContexts}
            onToggle={toggleContext}
            onDelete={deleteContextDoc}
            onReextract={reextractContext}
            loadCategory={loadCategoryMarkdown}
            entriesApi={entriesApiFor}
            onEntriesState={setKnowledge}
            onDismissConflict={dismissConflict}
            onAcceptProposal={acceptProposal}
            onDismissProposal={dismissProposal}
            onClose={() => setShowContexts(false)}
          />
        )}
      </div>
      {chatCollapsed ? (
        <div className="chat-rail">
          <button
            className="chat-expand"
            onClick={toggleChat}
            title="AI チャットを開く"
          >
            💬
          </button>
          {(loading || remoteBusy) && <span className="chat-rail-busy">…</span>}
        </div>
      ) : (
        <ChatPanel
          messages={messages}
          loading={loading}
          remoteBusy={remoteBusy}
          selectedTarget={selectedTarget}
          onClearSelection={() => setSelectedTarget(null)}
          onSend={sendMessage}
          onRetry={retryLast}
          onClear={clearChat}
          onCollapse={toggleChat}
        />
      )}
    </div>
  );
}
