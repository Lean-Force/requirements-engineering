// インフラ層: ドメイン知識ベースの保存先。
//
// アップロードされたファイルは「ソース(原資料)」として保存され、LLM が
// 固定カテゴリのドメイン知識エントリへ抽出・分解する(agent.extractKnowledge)。
// AI に提示されるのはカテゴリごとの Agent Skill(kb-*)で、description に
// エントリのタイトル一覧が入るため、資料名ベースよりトリガー精度が高い。
//
//   data/workspace/
//     sources.json                    ← ソースのメタ情報(SourceMeta[])
//     knowledge.json                  ← 抽出済みエントリ(KnowledgeEntry[])
//     sources/<id>/<原ファイル>        ← 原資料(再抽出・出典確認用)
//     .claude/skills/kb-<cat>/SKILL.md ← カテゴリ別にレンダリングされた知識
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
import { workspaceDir } from "./workspace";

export { workspaceDir } from "./workspace";

// カテゴリの定義(表示名・skill 名・「いつ読むか」のヒント)
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

export function categoryLabel(category: KnowledgeCategory): string {
  return CATEGORIES.find((c) => c.category === category)?.label ?? category;
}

function skillName(category: KnowledgeCategory): string {
  return `kb-${category}`;
}

// ---- ファイルパス ----------------------------------------------------------

function sourcesFile(): string {
  return path.join(workspaceDir(), "sources.json");
}

function knowledgeFile(): string {
  return path.join(workspaceDir(), "knowledge.json");
}

function sourceDir(id: string): string {
  return path.join(workspaceDir(), "sources", id);
}

function skillDir(category: KnowledgeCategory): string {
  return path.join(workspaceDir(), ".claude", "skills", skillName(category));
}

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

const readSources = () => readJson<SourceMeta[]>(sourcesFile(), []);
const readEntries = () => readJson<KnowledgeEntry[]>(knowledgeFile(), []);

// ---- 公開 API ------------------------------------------------------------

/** 知識ベースの全体像(ソース一覧 + カテゴリ別エントリ数) */
export async function getKnowledgeState(): Promise<KnowledgeState> {
  const [sources, entries] = await Promise.all([readSources(), readEntries()]);
  return { sources, categories: summarize(sources, entries) };
}

/**
 * ファイル 1 つをソースとして取り込む:
 * 原資料の保存 → Markdown 化 → LLM でドメイン知識を抽出 → カテゴリ skill を再レンダリング。
 */
export async function addSource(
  fileName: string,
  buffer: Buffer,
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

  const id = newId();
  await fs.mkdir(sourceDir(id), { recursive: true });
  await fs.writeFile(path.join(sourceDir(id), fileName), buffer);

  const sources = await readSources();
  const entries = await readEntries();
  sources.push({
    id,
    fileName,
    enabled: true,
    entryCount: extracted.length,
    uploadedAt: new Date().toISOString(),
  });
  for (const e of extracted) {
    entries.push({ id: newId(), sourceId: id, ...e });
  }
  await writeJson(sourcesFile(), sources);
  await writeJson(knowledgeFile(), entries);
  await renderSkills(sources, entries);
  return { sources, categories: summarize(sources, entries) };
}

export async function setSourceEnabled(
  id: string,
  enabled: boolean,
): Promise<KnowledgeState> {
  const sources = await readSources();
  const source = sources.find((s) => s.id === id);
  if (!source) throw new Error("指定の資料が見つかりません");
  source.enabled = enabled;
  const entries = await readEntries();
  await writeJson(sourcesFile(), sources);
  await renderSkills(sources, entries);
  return { sources, categories: summarize(sources, entries) };
}

export async function deleteSource(id: string): Promise<KnowledgeState> {
  const sources = await readSources();
  if (!sources.some((s) => s.id === id)) {
    throw new Error("指定の資料が見つかりません");
  }
  const nextSources = sources.filter((s) => s.id !== id);
  const nextEntries = (await readEntries()).filter((e) => e.sourceId !== id);
  await fs.rm(sourceDir(id), { recursive: true, force: true });
  await writeJson(sourcesFile(), nextSources);
  await writeJson(knowledgeFile(), nextEntries);
  await renderSkills(nextSources, nextEntries);
  return { sources: nextSources, categories: summarize(nextSources, nextEntries) };
}

/** チャット時に query() の skills オプションへ渡す、エントリのあるカテゴリ skill 名 */
export async function enabledSkillNames(): Promise<string[]> {
  const { categories } = await getKnowledgeState();
  return categories.filter((c) => c.count > 0).map((c) => skillName(c.category));
}

/** カテゴリの知識(有効ソース由来)を閲覧用 Markdown で返す */
export async function getCategoryMarkdown(
  category: KnowledgeCategory,
): Promise<{ label: string; markdown: string }> {
  const def = CATEGORIES.find((c) => c.category === category);
  if (!def) throw new Error("指定のカテゴリが見つかりません");
  const [sources, entries] = await Promise.all([readSources(), readEntries()]);
  const body = renderCategoryBody(category, sources, entries);
  return {
    label: def.label,
    markdown: body || "(このカテゴリの知識はまだありません)",
  };
}

/** ソース 1 件から抽出されたエントリを閲覧用 Markdown で返す(出典確認用) */
export async function getSourceMarkdown(
  id: string,
): Promise<{ meta: SourceMeta; markdown: string }> {
  const sources = await readSources();
  const meta = sources.find((s) => s.id === id);
  if (!meta) throw new Error("指定の資料が見つかりません");
  const entries = (await readEntries()).filter((e) => e.sourceId === id);
  const markdown = CATEGORIES.map((c) => {
    const list = entries.filter((e) => e.category === c.category);
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
    sources.filter((s) => s.enabled).map((s) => [s.id, s.fileName]),
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

/** カテゴリ別 SKILL.md を knowledge.json から再レンダリングする */
async function renderSkills(
  sources: SourceMeta[],
  entries: KnowledgeEntry[],
): Promise<void> {
  const enabledIds = new Set(sources.filter((s) => s.enabled).map((s) => s.id));

  for (const c of CATEGORIES) {
    const list = entries.filter(
      (e) => e.category === c.category && enabledIds.has(e.sourceId),
    );
    const dir = skillDir(c.category);

    if (list.length === 0) {
      // 空カテゴリの skill は残さない(AI に空の選択肢を見せない)
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }

    // description にタイトル一覧を入れる(AI が読む/読まないを決める手がかり)。
    // skill 仕様の description 上限(1024 文字)に収まるよう切り詰める。
    const titles = truncateList(list.map((e) => e.title), 700);
    const description = `ドメイン知識: ${c.label}(${titles})。${c.whenToRead}に読むこと。`;

    const body = renderCategoryBody(c.category, sources, entries);
    const skillMd = `---
name: ${skillName(c.category)}
description: ${oneLine(description)}
---

# ${c.label}

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
