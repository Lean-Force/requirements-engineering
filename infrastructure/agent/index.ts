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
//   USM_FAKE_LLM=1            : (テスト専用)LLM を決定的フェイク(fake.ts)に差し替える

import { promises as fs } from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatMessage,
  ChatResponse,
  EntryRevision,
  KnowledgeCategory,
  RefineRequest,
  RefineResponse,
} from "@/contracts";
import type { StoryMap } from "@/domain";
import { dataRoot, workspaceDir } from "../context/workspace";
import { boardToolsServer } from "./board-tools";
import {
  CONFLICT_DETECT_SYSTEM_PROMPT,
  ENTRY_REVISE_SYSTEM_PROMPT,
  EXTRACT_CATEGORY_DEFS,
  EXTRACT_ORCHESTRATOR_PROMPT,
  extractSubagentPrompt,
  extractSystemPrompt,
  REFINE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "./prompts";
import {
  fakeDetectConflicts,
  fakeExtract,
  fakeGenerate,
  fakeRefine,
  fakeReviseEntry,
  isFakeLlm,
} from "./fake";
import {
  CHAT_OUTPUT_SCHEMA,
  CONFLICT_SCHEMA,
  ENTRY_REVISE_SCHEMA,
  EXTRACT_SCHEMA,
  REFINE_SCHEMA,
} from "./schema";

/** LLM の接続設定があるか(Bedrock / Anthropic API 直結 / ローカル認証のいずれか) */
export function isConfigured(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    process.env.CLAUDE_LOCAL_AUTH === "1" ||
    isFakeLlm()
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
  if (isFakeLlm()) return fakeGenerate(conversation);
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
      hooks: workspaceGuard(workspace),
    },
  });

  // AI が実際に読んだドメイン知識。skill の読み込みは Skill ツール
  // ({skill: "kb-…"})で行われる。SKILL.md を直接 Read するケースも保険で拾う。
  // 「読むべき時に読んだか」の eval と、参照表示に使う。
  const usedSkills = new Set<string>();
  // セッションに実際にロードされた skill(「渡したつもり」との突合用)
  let loadedSkills: string[] = [];

  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      loadedSkills = message.skills;
      warnIfSkillsMissing("chat", skillNames, loadedSkills);
      continue;
    }
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
          loadedSkills,
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

// ---- 付箋の校正(推敲) -----------------------------------------------------

/**
 * 付箋(行動 / ストーリー)1 枚の本文を推奨形式・ドメイン知識(用語)に沿って推敲する。
 * skillNames はチャットと同じ(prepareSkillsForChat の結果)を渡す。
 */
export async function refineCard(
  boardId: string,
  req: RefineRequest,
  skillNames: string[],
): Promise<RefineResponse> {
  if (isFakeLlm()) return fakeRefine(req);
  const workspace = workspaceDir(boardId);
  await fs.mkdir(workspace, { recursive: true });

  const kindLabel = req.kind === "story" ? "ストーリー" : "行動";
  const context = [
    req.actorName ? `アクター: ${req.actorName}` : null,
    req.sceneActions?.length
      ? `同じ場面の行動: ${req.sceneActions.join(" / ")}`
      : null,
    req.actionText ? `ぶら下がっている行動: ${req.actionText}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  const q = query({
    prompt: `次の${kindLabel}の付箋を推敲してください。\n\n${context}\n\n本文:\n${req.text}`,
    options: {
      model: process.env.ANTHROPIC_MODEL || undefined,
      cwd: workspace,
      systemPrompt: REFINE_SYSTEM_PROMPT,
      settingSources: ["project"],
      skills: skillNames,
      // 用語合わせのために知識を読む以外の行動はさせない
      allowedTools: ["Read", "Glob", "Grep"],
      maxTurns: 8,
      outputFormat: { type: "json_schema", schema: REFINE_SCHEMA },
      hooks: workspaceGuard(workspace),
    },
  });

  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      warnIfSkillsMissing("refine", skillNames, message.skills);
      continue;
    }
    if (message.type !== "result") continue;
    if (message.subtype === "success") {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "refine-usage",
          turns: message.num_turns,
          durationMs: message.duration_ms,
          usage: message.usage,
          costUsd: message.total_cost_usd,
        }),
      );
      const output = message.structured_output as RefineResponse | undefined;
      if (!output) throw new Error("校正結果が得られませんでした");
      return output;
    }
    const errors =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join(" / ")
        : message.subtype;
    throw new Error(`校正に失敗しました: ${errors}`);
  }
  throw new Error("校正で有効な応答が得られませんでした");
}

// ---- ドメイン知識の抽出 -----------------------------------------------------

import type { DetectedConflict, ExtractedEntry } from "./types";
export type { DetectedConflict, ExtractedEntry } from "./types";

/**
 * 資料(Markdown 化済み)からドメイン知識エントリを抽出する(ツールなし 1 ターン)。
 * focus を指定すると、そのカテゴリだけを深く拾う観点別パスになる
 * (返るエントリの category は focus に固定する)。
 */
export async function extractKnowledge(
  fileName: string,
  markdown: string,
  focus?: KnowledgeCategory,
): Promise<ExtractedEntry[]> {
  if (isFakeLlm()) return fakeExtract(markdown);
  // cwd に指定するため、まだ無ければ作る(無いと spawn に失敗する)。
  // 抽出はツールを使わないためスコープに依存しない(データルート直下で実行)。
  await fs.mkdir(dataRoot(), { recursive: true });
  const q = query({
    prompt: `次の資料からドメイン知識を抽出してください。\n\n# 資料: ${fileName}\n\n${markdown}`,
    options: {
      model: process.env.ANTHROPIC_MODEL || undefined,
      cwd: dataRoot(),
      systemPrompt: extractSystemPrompt(focus),
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
          focus: focus ?? "all",
          usage: message.usage,
          costUsd: message.total_cost_usd,
        }),
      );
      const output = message.structured_output as
        | { entries: ExtractedEntry[] }
        | undefined;
      if (!output) throw new Error("知識の抽出結果が得られませんでした");
      // 観点別パスでは category を担当カテゴリに固定する(混入防止)
      return focus
        ? output.entries.map((e) => ({ ...e, category: focus }))
        : output.entries;
    }
    const errors =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join(" / ")
        : message.subtype;
    throw new Error(`知識の抽出に失敗しました: ${errors}`);
  }
  throw new Error("知識の抽出で有効な応答が得られませんでした");
}

/**
 * 観点別 subagent による知識抽出(Agent SDK の agents オプション)。
 * オーケストレータが 5 観点の subagent(extract-<category>)を 1 メッセージで
 * 並列起動し、各 subagent は一時ワークスペースの source.md を自分で読んで
 * 担当観点のエントリを返す。オーケストレータは結果を統合して構造化出力で返す。
 * 1 パスに全カテゴリを任せるより拾い漏れが減る(比較は tests/eval の再現率ケース)。
 */
export async function extractKnowledgeMulti(
  fileName: string,
  markdown: string,
): Promise<ExtractedEntry[]> {
  if (isFakeLlm()) return fakeExtract(markdown);
  // 資料をファイルとして置き、subagent に Read させる
  // (オーケストレータの出力トークン経由で全文を配り直すと高コストかつ欠落しやすい)
  const dir = path.join(
    dataRoot(),
    "extract-tmp",
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "source.md"),
    `# 資料: ${fileName}\n\n${markdown}`,
    "utf-8",
  );

  try {
    const q = query({
      prompt: `資料 source.md(元ファイル名: ${fileName})について、5 観点の subagent をすべて並列起動してドメイン知識を抽出し、統合してください。`,
      options: {
        model: process.env.ANTHROPIC_MODEL || undefined,
        cwd: dir,
        systemPrompt: EXTRACT_ORCHESTRATOR_PROMPT,
        settingSources: [],
        // 観点別 subagent の定義(モデルはメインを継承)
        agents: Object.fromEntries(
          EXTRACT_CATEGORY_DEFS.map((c) => [
            `extract-${c.category}`,
            {
              description: `${c.label}(${c.detail})の観点で資料 source.md から知識エントリを抽出する`,
              prompt: extractSubagentPrompt(c.category),
              tools: ["Read"],
            },
          ]),
        ),
        // オーケストレータには subagent 起動だけを許可する
        allowedTools: ["Agent", "Task"],
        maxTurns: 12,
        outputFormat: { type: "json_schema", schema: EXTRACT_SCHEMA },
        hooks: workspaceGuard(dir),
      },
    });

    // 実際に起動された観点(全 5 観点が起動されたかの監視用)
    const launched = new Set<string>();

    for await (const message of q) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type !== "tool_use") continue;
          if (block.name === "Agent" || block.name === "Task") {
            const t = (block.input as { subagent_type?: string }).subagent_type;
            if (t) launched.add(t);
          }
        }
        continue;
      }
      if (message.type !== "result") continue;
      if (message.subtype === "success") {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            kind: "extract-usage",
            fileName,
            focus: "subagents",
            launched: [...launched],
            turns: message.num_turns,
            durationMs: message.duration_ms,
            usage: message.usage,
            costUsd: message.total_cost_usd,
          }),
        );
        const output = message.structured_output as
          | { entries: ExtractedEntry[] }
          | undefined;
        if (!output) throw new Error("知識の抽出結果が得られませんでした");
        if (launched.size < EXTRACT_CATEGORY_DEFS.length) {
          // 起動漏れは取りこぼしに直結するため失敗として扱う(呼び出し元でエラー表示)
          throw new Error(
            `一部の観点が実行されませんでした(実行済み: ${[...launched].join(", ") || "なし"})。再試行してください`,
          );
        }
        return output.entries;
      }
      const errors =
        "errors" in message && Array.isArray(message.errors)
          ? message.errors.join(" / ")
          : message.subtype;
      throw new Error(`知識の抽出に失敗しました: ${errors}`);
    }
    throw new Error("知識の抽出で有効な応答が得られませんでした");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---- 知識エントリの協働修正 --------------------------------------------------

/**
 * 知識エントリ 1 件をユーザーの指示に沿って修正する(原資料の全文を根拠として渡す)。
 * 提案を返すだけで保存はしない(適用はユーザーが決める)。
 */
export async function reviseEntry(
  fileName: string,
  sourceMarkdown: string,
  current: { category: KnowledgeCategory; title: string; content: string; common: boolean },
  instruction: string,
): Promise<EntryRevision> {
  if (isFakeLlm()) return fakeReviseEntry(current, instruction);
  await fs.mkdir(dataRoot(), { recursive: true });
  const q = query({
    prompt: `# 原資料: ${fileName}

${sourceMarkdown}

# 現在のエントリ(カテゴリ: ${current.category})
title: ${current.title}
common: ${current.common}
content:
${current.content}

# ユーザーの修正指示
${instruction}`,
    options: {
      model: process.env.ANTHROPIC_MODEL || undefined,
      cwd: dataRoot(),
      systemPrompt: ENTRY_REVISE_SYSTEM_PROMPT,
      settingSources: [],
      allowedTools: [],
      maxTurns: 4,
      outputFormat: { type: "json_schema", schema: ENTRY_REVISE_SCHEMA },
    },
  });

  for await (const message of q) {
    if (message.type !== "result") continue;
    if (message.subtype === "success") {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "entry-revise-usage",
          fileName,
          usage: message.usage,
          costUsd: message.total_cost_usd,
        }),
      );
      const output = message.structured_output as EntryRevision | undefined;
      if (!output) throw new Error("修正案が得られませんでした");
      return output;
    }
    const errors =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join(" / ")
        : message.subtype;
    throw new Error(`修正案の生成に失敗しました: ${errors}`);
  }
  throw new Error("修正案の生成で有効な応答が得られませんでした");
}

// ---- 矛盾検出 ---------------------------------------------------------------

/**
 * 新しく取り込んだ知識と既存知識の実質的な食い違いを検出する(ツールなし 1 ターン)。
 * existingBlocks は「出典ラベル付きの既存知識テキスト」(呼び出し元が組み立てる)。
 */
export async function detectConflicts(
  newSourceName: string,
  newEntriesText: string,
  existingBlocks: string,
): Promise<DetectedConflict[]> {
  if (isFakeLlm()) return fakeDetectConflicts(newEntriesText);
  await fs.mkdir(dataRoot(), { recursive: true });
  const q = query({
    prompt: `# 新しく取り込んだ資料: ${newSourceName}

${newEntriesText}

# 既存の知識(出典ラベル付き)

${existingBlocks}`,
    options: {
      model: process.env.ANTHROPIC_MODEL || undefined,
      cwd: dataRoot(),
      systemPrompt: CONFLICT_DETECT_SYSTEM_PROMPT,
      settingSources: [],
      allowedTools: [],
      maxTurns: 4,
      outputFormat: { type: "json_schema", schema: CONFLICT_SCHEMA },
    },
  });

  for await (const message of q) {
    if (message.type !== "result") continue;
    if (message.subtype === "success") {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "conflict-scan-usage",
          fileName: newSourceName,
          usage: message.usage,
          costUsd: message.total_cost_usd,
        }),
      );
      const output = message.structured_output as
        | { conflicts: DetectedConflict[] }
        | undefined;
      if (!output) throw new Error("矛盾検出の結果が得られませんでした");
      return output.conflicts;
    }
    const errors =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join(" / ")
        : message.subtype;
    throw new Error(`矛盾検出に失敗しました: ${errors}`);
  }
  throw new Error("矛盾検出で有効な応答が得られませんでした");
}

// ---- 内部 ----------------------------------------------------------------

/**
 * 渡した skill 名がセッションへ実際にロードされたかを突合し、欠けていれば warn を出す。
 * SKILL.md はあるのに SDK が発見しない類の事故(settingSources 未指定など)を運用ログで検知する。
 */
function warnIfSkillsMissing(
  where: string,
  requested: string[],
  loaded: string[],
): void {
  const missing = requested.filter((name) => !loaded.includes(name));
  if (missing.length === 0) return;
  console.warn(
    JSON.stringify({
      at: new Date().toISOString(),
      kind: "skills-mismatch",
      where,
      requested,
      loaded,
      missing,
    }),
  );
}

/**
 * ワークスペース外の読み取りを遮断する PreToolUse フック。
 * allowedTools のツールは canUseTool より先に自動許可されるため、
 * すべての呼び出しに介入できる PreToolUse で検査する。
 */
function workspaceGuard(workspace: string) {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
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
  };
}

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
