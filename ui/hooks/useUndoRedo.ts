"use client";

// ボード直接編集の Undo / Redo(⌘Z / ⇧⌘Z)。
// AI ターンや他メンバーの変更を取り込んだら clear() を呼ぶこと
// (他人の変更まで巻き戻さないため)。入力中(input / textarea)は無効。

import { useCallback, useEffect, useRef } from "react";
import type { StoryMap } from "@/domain";

const MAX_HISTORY = 50;

export function useUndoRedo(
  current: StoryMap,
  apply: (next: StoryMap) => void,
) {
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const undoRef = useRef<StoryMap[]>([]);
  const redoRef = useRef<StoryMap[]>([]);

  const clear = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
  }, []);

  /** 編集の直前に呼ぶ(現在の状態を履歴へ積む) */
  const track = useCallback(() => {
    undoRef.current.push(currentRef.current);
    if (undoRef.current.length > MAX_HISTORY) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      )
        return;
      e.preventDefault();
      if (e.shiftKey) {
        const next = redoRef.current.pop();
        if (!next) return;
        undoRef.current.push(currentRef.current);
        apply(next);
      } else {
        const prev = undoRef.current.pop();
        if (!prev) return;
        redoRef.current.push(currentRef.current);
        apply(prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [apply]);

  return { track, clear };
}
