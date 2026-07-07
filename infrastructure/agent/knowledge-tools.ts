// チャットからドメイン知識を修正・蓄積するためのカスタムツール(アプリ内 MCP サーバー)。
//
// 実装はハンドラ注入方式: このモジュールはインターフェースだけを知り、
// 実体(context のユースケース)はチャットルートが結線する。
// context → agent の依存方向(抽出などで agent を使う)を壊さないための逆転。

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { KnowledgeCategory } from "@/contracts";

/** チャットルートが実装して渡す、知識操作の実体 */
export interface KnowledgeToolHandlers {
  /** 全ボード共有のエントリの一覧(id・カテゴリ・タイトル・出典) */
  list(): Promise<
    {
      id: string;
      category: KnowledgeCategory;
      title: string;
      common: boolean;
      edited: boolean;
      source: string;
    }[]
  >;
  /** エントリを修正する(✍️ 修正済み = 再抽出でも上書きされない扱いになる) */
  update(
    entryId: string,
    patch: { title?: string; content?: string; common?: boolean },
  ): Promise<string>;
  /** エントリを削除する */
  remove(entryId: string): Promise<string>;
  /** 会話で決まった知識を「チャットでの決定」として追加する */
  add(entry: {
    category: KnowledgeCategory;
    title: string;
    content: string;
    common?: boolean;
  }): Promise<string>;
  /** 資料(ソース)の一覧 */
  listSources(): Promise<
    { id: string; fileName: string; enabled: boolean; entryCount: number }[]
  >;
  /** 資料の on/off(off = 知識を AI へ提示しない。元に戻せる) */
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<string>;
  /** 資料の削除(抽出済みの知識ごと消える。元に戻せない) */
  removeSource(sourceId: string): Promise<string>;
  /** 資料の再抽出(原ファイルから知識を読み直す。数十秒かかる) */
  reextractSource(sourceId: string): Promise<string>;
}

const CATEGORY = z.enum(["terms", "actors", "flows", "data", "background"]);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function knowledgeToolsServer(handlers: KnowledgeToolHandlers) {
  return createSdkMcpServer({
    name: "kb",
    tools: [
      tool(
        "list_knowledge_entries",
        "全ボード共有のドメイン知識エントリの一覧(id つき)。修正・削除の前に対象の id を特定するために使う。",
        {},
        async () => {
          const entries = await handlers.list();
          if (entries.length === 0) return text("(編集できるエントリはありません)");
          return text(
            entries
              .map(
                (e) =>
                  `- id: ${e.id} [${e.category}${e.common ? "/共通" : ""}${e.edited ? "/修正済み" : ""}] ${e.title}(出典: ${e.source})`,
              )
              .join("\n"),
          );
        },
      ),
      tool(
        "update_knowledge_entry",
        "ドメイン知識エントリを修正する。ユーザーが知識の修正を明示的に頼んだときだけ使う。先に list_knowledge_entries で id を特定すること。修正は「人の合意による修正」として扱われ、再抽出でも上書きされない。",
        {
          entryId: z.string().describe("list_knowledge_entries で得たエントリ id"),
          title: z.string().optional().describe("新しいタイトル(変更する場合)"),
          content: z.string().optional().describe("新しい本文(変更する場合)"),
          common: z
            .boolean()
            .optional()
            .describe("(現在は全知識が共有のため無視される)"),
        },
        async ({ entryId, title, content, common }) =>
          text(await handlers.update(entryId, { title, content, common })),
      ),
      tool(
        "delete_knowledge_entry",
        "ドメイン知識エントリを削除する。ユーザーが明示的に頼んだときだけ使う。",
        { entryId: z.string().describe("list_knowledge_entries で得たエントリ id") },
        async ({ entryId }) => text(await handlers.remove(entryId)),
      ),
      tool(
        "list_sources",
        "全ボード共有の資料(ソース)の一覧(id・有効/無効・抽出件数)。資料単位の操作の前に id を特定するために使う。",
        {},
        async () => {
          const sources = await handlers.listSources();
          if (sources.length === 0) return text("(資料はありません)");
          return text(
            sources
              .map(
                (s) =>
                  `- id: ${s.id} ${s.fileName}(${s.enabled ? "有効" : "無効"}・${s.entryCount} 件)`,
              )
              .join("\n"),
          );
        },
      ),
      tool(
        "set_source_enabled",
        "資料を on/off する。off にするとその資料由来の知識が AI への提示(コンテキスト)から外れる(元に戻せる)。ユーザーが明示的に頼んだときだけ使う。",
        {
          sourceId: z.string().describe("list_sources で得た資料 id"),
          enabled: z.boolean().describe("true = 有効化 / false = 無効化"),
        },
        async ({ sourceId, enabled }) => text(await handlers.setSourceEnabled(sourceId, enabled)),
      ),
      tool(
        "delete_source",
        "資料を削除する(抽出済みの知識ごと消え、元に戻せない)。ユーザーの依頼が明確なときだけ使う。迷ったら off(set_source_enabled)を提案する。",
        { sourceId: z.string().describe("list_sources で得た資料 id") },
        async ({ sourceId }) => text(await handlers.removeSource(sourceId)),
      ),
      tool(
        "reextract_source",
        "資料の原ファイルから知識を再抽出する(読み取りが不十分・不正確なとき)。数十秒かかる。人が直したエントリ(修正済み)は保持される。",
        { sourceId: z.string().describe("list_sources で得た資料 id") },
        async ({ sourceId }) => text(await handlers.reextractSource(sourceId)),
      ),
      tool(
        "add_knowledge_entry",
        "会話で確定した決定・定義・ルールをドメイン知識として残す。ユーザーが「知識に残して」「覚えておいて」等と明示的に頼んだときだけ使う。出典は「チャットでの決定」になる。",
        {
          category: CATEGORY.describe("知識カテゴリ"),
          title: z.string().describe("短い見出し"),
          content: z.string().describe("本文(数値・条件は正確に)"),
          common: z
            .boolean()
            .optional()
            .describe("(現在は全知識が共有のため無視される)"),
        },
        async (entry) => text(await handlers.add(entry)),
      ),
    ],
  });
}
