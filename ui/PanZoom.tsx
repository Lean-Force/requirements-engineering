"use client";

import { useEffect, useRef, useState } from "react";

// Figma 風のキャンバス操作を提供するラッパ。
//   - 右 / 中ボタンのドラッグ … パン(移動)
//   - Ctrl/⌘ + ホイール        … カーソル位置を中心にズーム
//   - 素のホイール             … パン(縦・横)
//   - 右下のコントロール        … ＋ / − / 倍率(クリックでリセット)
// 子(ボード)には一切手を入れず、transform で見た目だけ動かす。

const MIN_Z = 0.2;
const MAX_Z = 3;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface Transform {
  x: number;
  y: number;
  z: number;
}

const INITIAL: Transform = { x: 20, y: 20, z: 1 };

export default function PanZoom({ children }: { children: React.ReactNode }) {
  const vpRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState<Transform>(INITIAL);
  const tRef = useRef(t);
  tRef.current = t;
  const pan = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  // ホイールは passive だと preventDefault できないため、ネイティブで非 passive 登録する。
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setT((prev) => {
        if (e.ctrlKey || e.metaKey) {
          const z = clamp(prev.z * Math.exp(-e.deltaY * 0.0015), MIN_Z, MAX_Z);
          const k = z / prev.z;
          // カーソル下の点を固定したままズーム
          return { z, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
        }
        return { ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY };
      });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 右(2)・中(1)ボタンのみパン。左はカード操作に使う。
    if (e.button !== 2 && e.button !== 1) return;
    e.preventDefault();
    vpRef.current?.setPointerCapture(e.pointerId);
    const cur = tRef.current;
    pan.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: cur.x, oy: cur.y };
    setGrabbing(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    setT((prev) => ({ ...prev, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  };

  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pan.current?.id === e.pointerId) {
      pan.current = null;
      setGrabbing(false);
    }
  };

  // ボタンによるズーム(ビューポート中央を中心に)
  const zoomBy = (factor: number) => {
    const rect = vpRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    setT((prev) => {
      const z = clamp(prev.z * factor, MIN_Z, MAX_Z);
      const k = z / prev.z;
      return { z, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
    });
  };

  return (
    <div
      ref={vpRef}
      className={`pz-viewport ${grabbing ? "grabbing" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="pz-canvas"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.z})` }}
      >
        {children}
      </div>

      <div className="pz-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => zoomBy(1 / 1.2)} title="ズームアウト">
          −
        </button>
        <button className="pz-zoom" onClick={() => setT(INITIAL)} title="リセット">
          {Math.round(t.z * 100)}%
        </button>
        <button onClick={() => zoomBy(1.2)} title="ズームイン">
          ＋
        </button>
      </div>
    </div>
  );
}
