"use client";

// ボード同期 SSE の購読。「何が変わったか」の通知を受けてハンドラを呼ぶだけの薄いフック。
// EventSource は切断時に自動再接続する。ハンドラは ref 経由で最新を呼ぶため、
// 依存の変化で購読を張り直さない。

import { useEffect, useRef } from "react";
import type { BoardEvent } from "@/contracts";

export interface BoardEventHandlers {
  onStorymap?: () => void;
  onChatStart?: () => void;
  onChatEnd?: () => void;
  onContexts?: () => void;
  onDiscussions?: () => void;
}

export function useBoardEvents(apiBase: string, handlers: BoardEventHandlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const source = new EventSource(`${apiBase}/events`);
    source.onmessage = (e) => {
      let event: BoardEvent;
      try {
        event = JSON.parse(e.data) as BoardEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case "storymap":
          ref.current.onStorymap?.();
          break;
        case "chat:start":
          ref.current.onChatStart?.();
          break;
        case "chat:end":
          ref.current.onChatEnd?.();
          break;
        case "contexts":
          ref.current.onContexts?.();
          break;
        case "discussions":
          ref.current.onDiscussions?.();
          break;
      }
    };
    return () => source.close();
  }, [apiBase]);
}
