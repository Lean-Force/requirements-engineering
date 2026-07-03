// インフラ層: LLM ゲートウェイ(Claude Agent SDK 経由)。
//
// Amazon Bedrock 上の Claude をエージェントループ付きで呼ぶ。
// アップロードされた参照資料は Agent Skill(data/workspace/.claude/skills/)
// として保存されており、description が常駐提示され、本文は AI が必要と
// 判断したときだけ Read される(progressive disclosure)。
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
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  ChatMessage,
  ChatResponse,
  KnowledgeCategory,
} from "@/contracts";
import type { StoryMap } from "@/domain";
import { createBoard, listBoards } from "./boards";
import { dataRoot, workspaceDir } from "./context/workspace";

/** LLM の接続設定があるか(Bedrock / Anthropic API 直結 / ローカル認証のいずれか) */
export function isConfigured(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    process.env.CLAUDE_LOCAL_AUTH === "1"
  );
}

const SYSTEM_PROMPT = `あなたは User Story Mapping(USM)の専門ファシリテーターです。
ユーザーが自然言語で業務やプロダクトの流れを説明するので、それを「共有タイムライン」のバックボーンに整理し、更新後のマップ全体を返してください。

# モデル(重要)
- actors: 登場人物/利用者種別(例: 店員、お客様、管理者)。アプリ上では行ごとに色分けして表示される。
- activities: ナラティブフローを左→右の時系列に並べた「アクティビティ(場面/局面)」の配列。これがバックボーン。並び順が時系列。
- 各 activity の actions には、その場面で行動するアクターの行動付箋を置く(バックボーン)。1つの場面に複数アクターが関わるなら、それぞれの付箋を同じ activity に入れる(例: 同じ場面で店員「商品を受け取る」/お客様「商品を渡す」)。
- ある場面で行動しないアクターは、その activity に action を入れない(= 表示上は空欄になり、列で揃う)。
- ストーリーは必ず、いずれかの action(= あるアクターの、その場面での行動)にぶら下がる。各 action の stories にユーザーストーリーを置く。形式は必ず「(その action のアクター)は〜したい。なぜなら〜だからだ。」とし、目的・理由(なぜそうしたいのか)まで書く(例: 店員の「商品を確認する」action の下に「店員は、クーポンがあることをお客様に知らせたい。なぜなら、お客様にお得に買い物をしてもらい再来店につなげたいからだ。」)。
- 1つの action に複数ストーリーがある場合は時系列に並べる(配列の並び順が左→右)。stories は無くてもよい(空配列)。
- ストーリーを宙に浮かせない。必ずそのストーリーの主語アクターが、その場面に action(行動)を持つようにし、その action の stories に入れる。該当する行動が無ければ先に action を作る。

# 作り方の指針
1. まず最も代表的なアクターの行動の流れを、時系列の activities として並べる(これがバックボーンの軸)。
2. 同じ場面に別アクターが関わる場合、その activity の actions に対になる付箋を足す。多くは「同じ出来事の裏表」(店員が受け取る↔客が渡す)。
3. action.text は短く具体的な行動表現にする(例:「レジに立つ」「お金を受け取る」)。長い説明文にしない。
4. 場面の粒度は揃える。細かすぎる機能分解はしない(それは後のステップ)。

# 参照資料(Skill)の使い方
- 利用可能な参照資料(要件一覧・業務フロー・ヒアリングメモ・用語集など)が Skill として提示されることがある。
- ユーザーの説明に関係しそうな資料があれば内容を読み、マップへ反映する際の根拠・用語の正として使う。
- 資料とユーザーの発言が食い違う場合は、ユーザーの発言を優先しつつ reply で相違に触れる。

# ボード(業務)の管理
- このアプリは業務ごとにボードを持つ。あなたが今整理しているのは「現在のボード」のマップ。
- ユーザーが別の業務のボード作成を頼んだら create_board ツールで作成する(既存と重複しないよう、必要なら list_boards で確認)。
- 作成後は reply で「左上のプルダウンから開けます」と案内する。作成しただけでは現在のマップは変わらないので、storyMap は変更せずそのまま返す。
- 頼まれていないのに勝手にボードを作らない。

# 厳守するルール
1. 必ず「更新後のマップ全体」を structured output で返す。既存の要素を勝手に削除しない(ユーザーが削除を指示した場合を除く)。
2. 既存要素の id は絶対に変えない。新規要素には新しい一意な id を付ける(例: "actor-clerk", "activity-3", "action-pay")。
3. 各 action.actorId は必ず既存の actors のいずれかを指す。新しい登場人物が出たら actors に追加する。
4. activities は時系列順(配列の並び順が左→右)。順序が重要。
5. "fixed": true の要素(行動・ストーリー)は「チームが合意して確定した」ものである。本文・アクターの変更や削除は絶対にしない(fixed フラグごとそのまま返す)。ユーザーが確定要素の変更を求めたら、変更せず reply で「確定済みのため、先に確定を解除してください」と案内する。fixed を自分から付けたり外したりしない。
6. reply は日本語で簡潔に。マップへ加えた変更点を箇条書き的に説明する。長文の解説は不要。参照資料を使った場合はどれを参照したか一言添える。`;

// 構造化出力のスキーマ(reply + 更新後マップ)。domain の StoryMap と同形。
const CHAT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "storyMap"],
  properties: {
    reply: { type: "string" },
    storyMap: {
      type: "object",
      additionalProperties: false,
      required: ["actors", "activities"],
      properties: {
        actors: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
        },
        activities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "actions"],
            properties: {
              id: { type: "string" },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "actorId", "text", "stories"],
                  properties: {
                    id: { type: "string" },
                    actorId: { type: "string" },
                    text: { type: "string" },
                    fixed: { type: "boolean" },
                    stories: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "text"],
                        properties: {
                          id: { type: "string" },
                          text: { type: "string" },
                          fixed: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// チャットからボード(業務)を操作するためのカスタムツール(アプリ内 MCP サーバー)。
// ツールの実体はサーバー側の boards モジュールをそのまま呼ぶ。
function boardToolsServer() {
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
): Promise<Pick<ChatResponse, "reply" | "storyMap">> {
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

  for await (const message of q) {
    if (message.type !== "result") continue;

    if (message.subtype === "success") {
      // 利用量の記録(ユーザー識別なしのためターン単位)
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "chat-usage",
          turns: message.num_turns,
          durationMs: message.duration_ms,
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
      return output;
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

const EXTRACT_SYSTEM_PROMPT = `あなたは業務資料からドメイン知識を抽出する専門家です。
User Story Mapping の AI ファシリテーターが参照する「ドメイン知識ベース」を作るため、
与えられた資料を独立した知識エントリに分解して抽出してください。

# カテゴリ(この5つのみ)
- terms: 用語・概念の定義(業務用語、システム用語、略語、コード値の意味)
- actors: 登場人物・役割・システム(誰が/何が関わるか、責務)
- flows: 業務フロー・ルール・条件(いつ誰が何をするか、順序、分岐条件、承認ルール)
- data: データ項目・インターフェース定義・制約(項目名、型、必須、値域、フォーマット)
- background: 背景・目的・課題・要望(ヒアリングで得た不満、ニーズ、導入の狙い)

# 抽出ルール
1. 1 エントリ = 1 つの独立した知識。title は短く具体的に(後から検索する手がかりになる)。
2. content は資料の情報を落とさず簡潔な Markdown で。表の情報は表(Markdown テーブル)のまま保つ。
3. 値域・条件・数値・コード値は原文どおり正確に写す。推測で補完しない。
4. 資料に無いカテゴリのエントリは作らない(無理に全カテゴリを埋めない)。
5. 資料のメタ情報(ファイル名、シート名、版数)は知識ではないので抽出しない。`;

const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "content"],
        properties: {
          category: {
            type: "string",
            enum: ["terms", "actors", "flows", "data", "background"],
          },
          title: { type: "string" },
          content: { type: "string" },
        },
      },
    },
  },
};

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
