// ドメイン知識ベースのユースケース。
//
// アップロードされたファイルは「ソース(原資料)」として保存され、LLM が
// 固定カテゴリのドメイン知識エントリへ抽出・分解する(agent.extractKnowledge)。
// 永続化は repository.ts、AI 向けビュー(SKILL.md)のレンダリングは skills.ts が担う。
//
//   workspaces/<boardId>/
//     sources.json / knowledge.json / sources/<id>/<原ファイル>
//     .claude/skills/kb-<cat>/SKILL.md        ← このボード(業務)の知識
//     .claude/skills/kb-common-<cat>/SKILL.md ← チャット直前に _common から同期コピー
//   workspaces/_common/                        ← 業務横断の共通知識(正本)
//
// エントリは出典(sourceId)を保持する。同じタイトルが複数ソースから来た場合は
// 両論併記で出典を明示する(勝手に統合して情報を落とさない)。

import type {
  KnowledgeCategory,
  KnowledgeCategorySummary,
  KnowledgeEntry,
  KnowledgeState,
  SourceMeta,
} from "@/contracts";
import { extractKnowledge } from "../agent";
import { isSupportedFile, parseFile } from "./parse";
import {
  readEntries,
  readOriginal,
  readSources,
  removeSourceDir,
  saveOriginal,
  knowledgeFile,
  sourcesFile,
  writeJson,
} from "./repository";
import { CATEGORIES, renderCategoryBody, renderSkills, skillName } from "./skills";
import { COMMON_SCOPE } from "./workspace";

// ---- 読み取り(ボード + 共通のマージ) --------------------------------------

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

/** 知識ベースの全体像(ボード + 共通のソース一覧、カテゴリ別エントリ数) */
export async function getKnowledgeState(boardId: string): Promise<KnowledgeState> {
  const { sources, entries } = await readAll(boardId);
  return { sources, categories: summarize(sources, entries) };
}

// ---- 取り込み・再抽出 -------------------------------------------------------

/** ファイルを Markdown 化する(Excel の複数シートはセクションとして畳む) */
async function toMarkdown(fileName: string, buffer: Buffer): Promise<string> {
  const parsed = await parseFile(fileName, buffer);
  if (parsed.length === 0) {
    throw new Error(`内容が空のため取り込めませんでした: ${fileName}`);
  }
  return parsed
    .map((d) => (d.sheetName ? `## シート: ${d.sheetName}\n\n${d.markdown}` : d.markdown))
    .join("\n\n");
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
  const markdown = await toMarkdown(fileName, buffer);

  // LLM でドメイン知識エントリへ分解する(失敗したら取り込み自体を失敗させる)
  const extracted = await extractKnowledge(fileName, markdown);
  if (extracted.length === 0) {
    throw new Error(
      `ドメイン知識を抽出できませんでした: ${fileName}(内容を確認してください)`,
    );
  }

  const scope = common ? COMMON_SCOPE : boardId;
  const id = newId();
  await saveOriginal(scope, id, fileName, buffer);

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

/**
 * 保存済みの原ファイルからドメイン知識を再抽出する
 * (抽出プロンプトの改善後などに、取り込みをやり直すため)。
 */
export async function reextractSource(
  boardId: string,
  sourceId: string,
): Promise<KnowledgeState> {
  const scope = await scopeOf(boardId, sourceId);
  const sources = await readSources(scope);
  const meta = sources.find((s) => s.id === sourceId);
  if (!meta) throw new Error("指定の資料が見つかりません");

  const buffer = await readOriginal(scope, sourceId, meta.fileName);
  const markdown = await toMarkdown(meta.fileName, buffer);

  const extracted = await extractKnowledge(meta.fileName, markdown);
  if (extracted.length === 0) {
    throw new Error(`ドメイン知識を抽出できませんでした: ${meta.fileName}`);
  }

  // このソース由来のエントリを丸ごと差し替える
  const entries = (await readEntries(scope)).filter(
    (e) => e.sourceId !== sourceId,
  );
  for (const e of extracted) {
    entries.push({ id: newId(), sourceId, ...e });
  }
  meta.entryCount = extracted.length;
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await renderSkills(scope);
  return getKnowledgeState(boardId);
}

// ---- ソースの操作 -----------------------------------------------------------

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
  await removeSourceDir(scope, sourceId);
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await renderSkills(scope);
  return getKnowledgeState(boardId);
}

// ---- 閲覧(出典確認・カテゴリビュー) ---------------------------------------

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

// skillName は knowledge の公開 API ではないが、テスト・レンダラ間の整合のため re-export
export { skillName };
