// インフラ層: LLM ゲートウェイ(Claude Agent SDK 経由)。
//
// Amazon Bedrock 上の Claude をエージェントループ付きで呼ぶ。責務は
// 「query の組み立て・実行・結果の取り出し・利用量の記録」に限定し、
// 指示書は prompts.ts、スキーマは schema.ts(形は domain/schema.ts が正)、
// ボード操作ツールは board-tools.ts に分離している。
//
// ドメイン知識は Agent Skill(workspaces/<boardId>/.claude/skills/)として
// 保存されており、description が常駐提示され、本文は AI が必要と判断した
// ときだけ Read される(progressive disclosure)。
//
// 環境変数:
//   CLAUDE_CODE_USE_BEDROCK=1 : Bedrock 経由で呼ぶ(AWS 認証は標準チェーン。EKS では IRSA)
//   AWS_REGION                : Bedrock のリージョン
//   ANTHROPIC_MODEL           : モデル(Bedrock はインファレンスプロファイル形式。例 us.anthropic.claude-opus-4-8)
//   ANTHROPIC_API_KEY         : (ローカル開発向け)Anthropic API 直結の場合
//   CLAUDE_LOCAL_AUTH=1       : (ローカル開発向け)このマシンの Claude Code ログインを使う
//   CHAT_MAX_TURNS            : エージェントループの上限(省略時 24)

import { promises as fs } from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatMessage,
  ChatResponse,
  KnowledgeCategory,
} from "@/contracts";
import type { StoryMap } from "@/domain";
import { dataRoot, workspaceDir } from "../context/workspace";
import { boardToolsServer } from "./board-tools";
import { EXTRACT_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts";
import { CHAT_OUTPUT_SCHEMA, EXTRACT_SCHEMA } from "./schema";

/** LLM の接続設定があるか(Bedrock / Anthropic API 直結 / ローカル認証のいずれか) */
export function isConfigured(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    process.env.CLAUDE_LOCAL_AUTH === "1"
  );
}

/** 会話履歴を 1 本のプロンプトに畳む(Agent SDK の query は単一プロンプト入力) */
function renderConversation(conversation: ChatMessage[]): string {
  return conversation
    .map((m) => `[${m.role === "user" ? "ユーザー" : "あなた(過去の返信)"}]\n${m.content}`)
    .join("\n\n");
}

/**
 * 会話履歴から「返信 + 更新後マップ」を生成する。
 * skillNames には有効なドメイン知識(skill 名)を渡す。空配列なら知識なし。
 */
export async function generate(
  boardId: string,
  conversation: ChatMessage[],
  skillNames: string[],
): Promise<Pick<ChatResponse, "reply" | "storyMap" | "usedSkills">> {
  const workspace = workspaceDir(boardId);
  // cwd に指定するため、初回チャット時などまだ無ければ作る(無いと spawn に失敗する)
  await fs.mkdir(workspace, { recursive: true });
  const maxTurns = Number(process.env.CHAT_MAX_TURNS || 24);

  const q = query({
    prompt: renderConversation(conversation),
    options: {
      model: process.env.ANTHROPIC_MODEL || undefined,
      cwd: workspace,
      systemPrompt: SYSTEM_PROMPT,
      // skills は cwd の .claude/skills から発見される。settingSources を
      // 指定しないと設定を読まないため project を明示する。
      settingSources: ["project"],
      skills: skillNames,
      // ボード操作のカスタムツール(チャットからのボード作成)
      mcpServers: { usm: boardToolsServer() },
      // 知識を読む + ボード操作以外の行動はさせない
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "mcp__usm__list_boards",
        "mcp__usm__create_board",
      ],
      maxTurns,
      outputFormat: { type: "json_schema", schema: CHAT_OUTPUT_SCHEMA },
      // ワークスペース外の読み取りを遮断する(Read は絶対パスで任意の
      // ファイルを指せるため、対象パスを検査して deny する)。
      // allowedTools のツールは canUseTool より先に自動許可されるため、
      // すべての呼び出しに介入できる PreToolUse フックで検査する。
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const target = pathOf(
                  input.tool_name,
                  (input.tool_input ?? {}) as Record<string, unknown>,
                );
                if (target !== null && !isInside(workspace, target)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason:
                        "ワークスペース外のファイルへはアクセスできません",
                    },
                  };
                }
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  // AI が実際に読んだドメイン知識。skill の読み込みは Skill ツール
  // ({skill: "kb-…"})で行われる。SKILL.md を直接 Read するケースも保険で拾う。
  // 「読むべき時に読んだか」の eval と、参照表示に使う。
  const usedSkills = new Set<string>();

  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "Skill") {
          const skill = (block.input as { skill?: string }).skill ?? "";
          if (skill.startsWith("kb-")) usedSkills.add(skill);
        } else if (block.name === "Read") {
          const filePath = (block.input as { file_path?: string }).file_path ?? "";
          const hit = /\.claude\/skills\/(kb-[^/]+)\/SKILL\.md$/.exec(filePath);
          if (hit) usedSkills.add(hit[1]);
        }
      }
      continue;
    }
    if (message.type !== "result") continue;

    if (message.subtype === "success") {
      // 利用量の記録(ユーザー識別なしのためターン単位)
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "chat-usage",
          turns: message.num_turns,
          durationMs: message.duration_ms,
          usedSkills: [...usedSkills],
          usage: message.usage,
          costUsd: message.total_cost_usd,
        }),
      );
      const output = message.structured_output as
        | { reply: string; storyMap: StoryMap }
        | undefined;
      if (!output) {
        throw new Error("モデルから構造化出力が得られませんでした");
      }
      return { ...output, usedSkills: [...usedSkills] };
    }

    // result のエラー種別(ループ上限・構造化出力の失敗など)
    const errors =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join(" / ")
        : message.subtype;
    throw new Error(`エージェントの実行に失敗しました: ${errors}`);
  }

  throw new Error("モデルから有効な応答が得られませんでした");
}

// ---- ドメイン知識の抽出 -----------------------------------------------------

export interface ExtractedEntry {
  category: KnowledgeCategory;
  title: string;
  content: string;
}

/** 資料(Markdown 化済み)からドメイン知識エントリを抽出する(ツールなし 1 ターン) */
export async function extractKnowledge(
  fileName: string,
  markdown: string,
): Promise<ExtractedEntry[]> {
  // cwd に指定するため、まだ無ければ作る(無いと spawn に失敗する)。
  // 抽出はツールを使わないためスコープに依存しない(データルート直下で実行)。
  await fs.mkdir(dataRoot(), { recursive: true });
  const q = query({
    prompt: `次の資料からドメイン知識を抽出してください。\n\n# 資料: ${fileName}\n\n${markdown}`,
    options: {
      model: process.env.ANTHROPIC_MODEL || undefined,
      cwd: dataRoot(),
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      settingSources: [],
      allowedTools: [],
      maxTurns: 4,
      outputFormat: { type: "json_schema", schema: EXTRACT_SCHEMA },
    },
  });

  for await (const message of q) {
    if (message.type !== "result") continue;
    if (message.subtype === "success") {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "extract-usage",
          fileName,
          usage: message.usage,
          costUsd: message.total_cost_usd,
        }),
      );
      const output = message.structured_output as
        | { entries: ExtractedEntry[] }
        | undefined;
      if (!output) throw new Error("知識の抽出結果が得られませんでした");
      return output.entries;
    }
    const errors =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join(" / ")
        : message.subtype;
    throw new Error(`知識の抽出に失敗しました: ${errors}`);
  }
  throw new Error("知識の抽出で有効な応答が得られませんでした");
}

// ---- 内部 ----------------------------------------------------------------

/** ツール入力からアクセス対象パスを取り出す(該当しないツールは null) */
function pathOf(toolName: string, input: Record<string, unknown>): string | null {
  const value =
    toolName === "Read"
      ? input.file_path
      : toolName === "Glob" || toolName === "Grep"
        ? input.path
        : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isInside(root: string, target: string): boolean {
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}
