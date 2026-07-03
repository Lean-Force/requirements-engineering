// チャットからボード(業務)を操作するためのカスタムツール(アプリ内 MCP サーバー)。
// ツールの実体はサーバー側の boards モジュールをそのまま呼ぶ。

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createBoard, listBoards } from "../boards";

export function boardToolsServer() {
  return createSdkMcpServer({
    name: "usm",
    tools: [
      tool(
        "list_boards",
        "既存のボード(業務)の一覧を返す。ボード作成前の重複確認などに使う。",
        {},
        async () => {
          const boards = await listBoards();
          return {
            content: [
              {
                type: "text",
                text: boards.map((b) => `- ${b.name} (id: ${b.id})`).join("\n") || "(ボードなし)",
              },
            ],
          };
        },
      ),
      tool(
        "create_board",
        "新しいボード(業務)を作成する。ユーザーに別業務のボード作成を頼まれたときだけ使う。",
        { name: z.string().describe("ボード名(業務名。例: 口座開設)") },
        async ({ name }) => {
          const board = await createBoard(name);
          return {
            content: [
              {
                type: "text",
                text: `ボード「${board.name}」を作成しました(id: ${board.id})。ユーザーは左上のプルダウンから開けます。`,
              },
            ],
          };
        },
      ),
    ],
  });
}
