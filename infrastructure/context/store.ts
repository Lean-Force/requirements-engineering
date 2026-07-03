// インフラ層: ドメイン知識ベースの保存先(ボード = 業務ごと + 業務横断の共通)。
//
// アップロードされたファイルは「ソース(原資料)」として保存され、LLM が
// 固定カテゴリのドメイン知識エントリへ抽出・分解する(agent.extractKnowledge)。
// AI に提示されるのはカテゴリごとの Agent Skill で、description に
// エントリのタイトル一覧が入るため、資料名ベースよりトリガー精度が高い。
//
//   workspaces/<boardId>/
//     sources.json / knowledge.json / sources/<id>/<原ファイル>
//     .claude/skills/kb-<cat>/SKILL.md        ← このボード(業務)の知識
//     .claude/skills/kb-common-<cat>/SKILL.md ← チャット直前に _common から同期コピー
//   workspaces/_common/
//     sources.json / knowledge.json / sources/
//     .claude/skills/kb-common-<cat>/SKILL.md ← 業務横断の共通知識(正本)
//
// エントリは出典(sourceId)を保持する。同じタイトルが複数ソースから来た場合は
// 両論併記で出典を明示する(勝手に統合して情報を落とさない)。

import { promises as fs } from "fs";
import path from "path";
import type {
  KnowledgeCategory,
  KnowledgeCategorySummary,
  KnowledgeEntry,
  KnowledgeState,
  SourceMeta,
} from "@/contracts";
import { extractKnowledge } from "../agent";
import { isSupportedFile, parseFile } from "./parse";
import { COMMON_SCOPE, workspaceDir } from "./workspace";

export { COMMON_SCOPE, workspaceDir } from "./workspace";

// カテゴリの定義(表示名・「いつ読むか」のヒント)
const CATEGORIES: {
  category: KnowledgeCategory;
  label: string;
  whenToRead: string;
}[] = [
  { category: "terms", label: "用語集", whenToRead: "用語・概念の意味や定義を確認するとき" },
  { category: "actors", label: "アクター", whenToRead: "登場人物・役割・システムの責務を確認するとき" },
  { category: "flows", label: "業務フロー・ルール", whenToRead: "業務の流れ・順序・条件分岐・承認ルールを確認するとき" },
  { category: "data", label: "データ・IF定義", whenToRead: "データ項目・インターフェース・値域などの制約を確認するとき" },
  { category: "background", label: "背景・課題", whenToRead: "背景・目的・課題・ユーザーの要望を踏まえるとき" },
];

function skillName(category: KnowledgeCategory, scope: string): string {
  return scope === COMMON_SCOPE ? `kb-common-${category}` : `kb-${category}`;
}

// ---- ファイルパス(スコープ = boardId または _common) -----------------------

const sourcesFile = (scope: string) => path.join(workspaceDir(scope), "sources.json");
const knowledgeFile = (scope: string) => path.join(workspaceDir(scope), "knowledge.json");
const sourceDir = (scope: string, id: string) =>
  path.join(workspaceDir(scope), "sources", id);
const skillsRoot = (scope: string) =>
  path.join(workspaceDir(scope), ".claude", "skills");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

const readSources = (scope: string) =>
  readJson<SourceMeta[]>(sourcesFile(scope), []);
const readEntries = (scope: string) =>
  readJson<KnowledgeEntry[]>(knowledgeFile(scope), []);

/** ボード + 共通の両スコープを読み、ソースへ scope を付けて返す */
async function readAll(boardId: string): Promise<{
  sources: SourceMeta[];
  entries: KnowledgeEntry[];
}> {
  const [boardSources, boardEntries, commonSources, commonEntries] =
    await Promise.all([
      readSources(boardId),
      readEntries(boardId),
      readSources(COMMON_SCOPE),
      readEntries(COMMON_SCOPE),
    ]);
  return {
    sources: [
      ...boardSources.map((s) => ({ ...s, scope: "board" as const })),
      ...commonSources.map((s) => ({ ...s, scope: "common" as const })),
    ],
    entries: [...boardEntries, ...commonEntries],
  };
}

/** ソース id がどちらのスコープにあるかを解決する */
async function scopeOf(boardId: string, sourceId: string): Promise<string> {
  if ((await readSources(boardId)).some((s) => s.id === sourceId)) return boardId;
  if ((await readSources(COMMON_SCOPE)).some((s) => s.id === sourceId)) {
    return COMMON_SCOPE;
  }
  throw new Error("指定の資料が見つかりません");
}

// ---- 公開 API ------------------------------------------------------------

/** 知識ベースの全体像(ボード + 共通のソース一覧、カテゴリ別エントリ数) */
export async function getKnowledgeState(boardId: string): Promise<KnowledgeState> {
  const { sources, entries } = await readAll(boardId);
  return { sources, categories: summarize(sources, entries) };
}

/**
 * ファイル 1 つをソースとして取り込む:
 * 原資料の保存 → Markdown 化 → LLM でドメイン知識を抽出 → カテゴリ skill を再レンダリング。
 * common = true なら業務横断の共通知識として登録する。
 */
export async function addSource(
  boardId: string,
  fileName: string,
  buffer: Buffer,
  common = false,
): Promise<KnowledgeState> {
  if (!isSupportedFile(fileName)) {
    throw new Error(
      `未対応のファイル形式です: ${fileName}(xlsx / xls / csv / pdf / md / txt に対応)`,
    );
  }

  const parsed = await parseFile(fileName, buffer);
  if (parsed.length === 0) {
    throw new Error(`内容が空のため取り込めませんでした: ${fileName}`);
  }
  const markdown = parsed
    .map((d) => (d.sheetName ? `## シート: ${d.sheetName}\n\n${d.markdown}` : d.markdown))
    .join("\n\n");

  // LLM でドメイン知識エントリへ分解する(失敗したら取り込み自体を失敗させる)
  const extracted = await extractKnowledge(fileName, markdown);
  if (extracted.length === 0) {
    throw new Error(
      `ドメイン知識を抽出できませんでした: ${fileName}(内容を確認してください)`,
    );
  }

  const scope = common ? COMMON_SCOPE : boardId;
  const id = newId();
  await fs.mkdir(sourceDir(scope, id), { recursive: true });
  await fs.writeFile(path.join(sourceDir(scope, id), fileName), buffer);

  const sources = await readSources(scope);
  const entries = await readEntries(scope);
  sources.push({
    id,
    fileName,
    scope: common ? "common" : "board",
    enabled: true,
    entryCount: extracted.length,
    uploadedAt: new Date().toISOString(),
  });
  for (const e of extracted) {
    entries.push({ id: newId(), sourceId: id, ...e });
  }
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await renderSkills(scope);
  return getKnowledgeState(boardId);
}

export async function setSourceEnabled(
  boardId: string,
  sourceId: string,
  enabled: boolean,
): Promise<KnowledgeState> {
  const scope = await scopeOf(boardId, sourceId);
  const sources = await readSources(scope);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error("指定の資料が見つかりません");
  source.enabled = enabled;
  await writeJson(sourcesFile(scope), sources);
  await renderSkills(scope);
  return getKnowledgeState(boardId);
}

export async function deleteSource(
  boardId: string,
  sourceId: string,
): Promise<KnowledgeState> {
  const scope = await scopeOf(boardId, sourceId);
  const sources = (await readSources(scope)).filter((s) => s.id !== sourceId);
  const entries = (await readEntries(scope)).filter(
    (e) => e.sourceId !== sourceId,
  );
  await fs.rm(sourceDir(scope, sourceId), { recursive: true, force: true });
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await renderSkills(scope);
  return getKnowledgeState(boardId);
}

/**
 * チャット直前の準備: 共通知識の skill をボードのワークスペースへ同期コピーし、
 * query() の skills オプションへ渡す skill 名一覧(ボード + 共通)を返す。
 */
export async function prepareSkillsForChat(boardId: string): Promise<string[]> {
  const names: string[] = [];

  // ボード自身の知識
  const boardSources = await readSources(boardId);
  const boardEntries = await readEntries(boardId);
  const boardEnabled = new Set(
    boardSources.filter((s) => s.enabled).map((s) => s.id),
  );
  for (const c of CATEGORIES) {
    if (
      boardEntries.some(
        (e) => e.category === c.category && boardEnabled.has(e.sourceId),
      )
    ) {
      names.push(skillName(c.category, boardId));
    }
  }

  // 共通知識: _common の kb-common-* をボードのワークスペースへ同期コピー
  const boardSkills = skillsRoot(boardId);
  await fs.mkdir(boardSkills, { recursive: true });
  for (const entry of await fs.readdir(boardSkills).catch(() => [] as string[])) {
    if (entry.startsWith("kb-common-")) {
      await fs.rm(path.join(boardSkills, entry), { recursive: true, force: true });
    }
  }
  const commonSkills = skillsRoot(COMMON_SCOPE);
  for (const entry of await fs.readdir(commonSkills).catch(() => [] as string[])) {
    if (!entry.startsWith("kb-common-")) continue;
    await fs.cp(path.join(commonSkills, entry), path.join(boardSkills, entry), {
      recursive: true,
    });
    names.push(entry);
  }

  return names;
}

/** カテゴリの知識(ボード + 共通、有効ソース由来)を閲覧用 Markdown で返す */
export async function getCategoryMarkdown(
  boardId: string,
  category: KnowledgeCategory,
): Promise<{ label: string; markdown: string }> {
  const def = CATEGORIES.find((c) => c.category === category);
  if (!def) throw new Error("指定のカテゴリが見つかりません");
  const { sources, entries } = await readAll(boardId);
  const body = renderCategoryBody(category, sources, entries);
  return {
    label: def.label,
    markdown: body || "(このカテゴリの知識はまだありません)",
  };
}

/** ソース 1 件から抽出されたエントリを閲覧用 Markdown で返す(出典確認用) */
export async function getSourceMarkdown(
  boardId: string,
  sourceId: string,
): Promise<{ meta: SourceMeta; markdown: string }> {
  const { sources, entries } = await readAll(boardId);
  const meta = sources.find((s) => s.id === sourceId);
  if (!meta) throw new Error("指定の資料が見つかりません");
  const own = entries.filter((e) => e.sourceId === sourceId);
  const markdown = CATEGORIES.map((c) => {
    const list = own.filter((e) => e.category === c.category);
    if (list.length === 0) return null;
    return `# ${c.label}\n\n${list.map((e) => `## ${e.title}\n\n${e.content}`).join("\n\n")}`;
  })
    .filter((s): s is string => s !== null)
    .join("\n\n");
  return { meta, markdown: markdown || "(抽出されたエントリがありません)" };
}

// ---- 内部 ----------------------------------------------------------------

function newId(): string {
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function summarize(
  sources: SourceMeta[],
  entries: KnowledgeEntry[],
): KnowledgeCategorySummary[] {
  const enabledIds = new Set(sources.filter((s) => s.enabled).map((s) => s.id));
  return CATEGORIES.map((c) => ({
    category: c.category,
    label: c.label,
    count: entries.filter(
      (e) => e.category === c.category && enabledIds.has(e.sourceId),
    ).length,
  }));
}

function renderCategoryBody(
  category: KnowledgeCategory,
  sources: SourceMeta[],
  entries: KnowledgeEntry[],
): string {
  const enabled = new Map(
    sources
      .filter((s) => s.enabled)
      .map((s) => [
        s.id,
        s.scope === "common" ? `${s.fileName}(共通)` : s.fileName,
      ]),
  );
  const list = entries.filter(
    (e) => e.category === category && enabled.has(e.sourceId),
  );
  return list
    .map(
      (e) =>
        `## ${e.title}\n\n${e.content}\n\n_出典: ${enabled.get(e.sourceId)}_`,
    )
    .join("\n\n");
}

/** スコープのカテゴリ別 SKILL.md を再レンダリングする */
async function renderSkills(scope: string): Promise<void> {
  const sources = (await readSources(scope)).map((s) => ({
    ...s,
    scope: (scope === COMMON_SCOPE ? "common" : "board") as SourceMeta["scope"],
  }));
  const entries = await readEntries(scope);
  const enabledIds = new Set(sources.filter((s) => s.enabled).map((s) => s.id));
  const isCommon = scope === COMMON_SCOPE;

  for (const c of CATEGORIES) {
    const list = entries.filter(
      (e) => e.category === c.category && enabledIds.has(e.sourceId),
    );
    const name = skillName(c.category, scope);
    const dir = path.join(skillsRoot(scope), name);

    if (list.length === 0) {
      // 空カテゴリの skill は残さない(AI に空の選択肢を見せない)
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }

    // description にタイトル一覧を入れる(AI が読む/読まないを決める手がかり)。
    // skill 仕様の description 上限(1024 文字)に収まるよう切り詰める。
    const titles = truncateList(list.map((e) => e.title), 700);
    const prefix = isCommon ? "業務横断の共通知識" : "この業務のドメイン知識";
    const description = `${prefix}: ${c.label}(${titles})。${c.whenToRead}に読むこと。`;

    const body = renderCategoryBody(c.category, sources, entries);
    const skillMd = `---
name: ${name}
description: ${oneLine(description)}
---

# ${c.label}${isCommon ? "(業務横断)" : ""}

${body}
`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
  }
}

function truncateList(items: string[], maxChars: number): string {
  const out: string[] = [];
  let total = 0;
  for (const item of items) {
    if (total + item.length > maxChars) {
      out.push(`ほか${items.length - out.length}件`);
      break;
    }
    out.push(item);
    total += item.length + 3;
  }
  return out.join(" / ");
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}
