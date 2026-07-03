import { subscribe } from "@/infrastructure/events";
import type { BoardEvent } from "@/contracts";

export const dynamic = "force-dynamic";

// ボード同期用の SSE エンドポイント。
// 「何かが変わった」ことだけを push し、クライアントは必要なデータを再取得する。
// ALB 等の idle timeout 対策として定期的にコメント行(keep-alive)を送る。
const KEEP_ALIVE_MS = 25_000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: BoardEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* 切断後の enqueue は無視 */
        }
      };

      const unsubscribe = subscribe(send);
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          /* 切断後は無視 */
        }
      }, KEEP_ALIVE_MS);

      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* 既に閉じていれば無視 */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
