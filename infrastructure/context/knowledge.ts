// ドメイン知識ベースのユースケース。
//
// アップロードされたファイルは「ソース(原資料)」としてアップロードした場所
// (ボード or 共通管理画面 = _common)に保存され、LLM が固定カテゴリの
// ドメイン知識エントリへ抽出・分解する(agent.extractKnowledge)。
// その際、各エントリが業務固有か業務横断(common)かを AI が自動判定する。
// ユーザーはアップロード時にスコープを意識しない。
//
//   workspaces/<boardId>/
//     sources.json / knowledge.json / sources/<id>/<原ファイル>
//     .claude/skills/kb-<cat>/SKILL.md        ← このボードの業務固有知識
//     .claude/skills/kb-common-<cat>/SKILL.md ← チャット直前に _common から同期コピー
//   workspaces/_common/
//     .claude/skills/kb-common-<cat>/SKILL.md ← 全スコープの common エントリの合成(正本)
//
// 永続化は repository.ts、AI 向けビュー(SKILL.md)のレンダリングは skills.ts が担う。
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
import { listBoards } from "../boards";
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
import {
  CATEGORIES,
  renderCategoryBody,
  renderCommonSkills,
  renderSkills,
} from "./skills";
import { COMMON_SCOPE } from "./workspace";

// ---- 読み取り --------------------------------------------------------------
//
// ビューは 2 種類:
//   boardId = 文字列 … そのボードの資料 + AI から見える知識(業務固有 + 全共通)
//   boardId = null   … 共通管理画面(_common の資料 + 全スコープの共通知識)

/** ビューを所有スコープへ解決する */
const ownerScope = (boardId: string | null): string => boardId ?? COMMON_SCOPE;

/**
 * ビューから見える知識を集める:
 *   - labelOf: 有効なソース id → 出典表示名(他スコープ由来の共通知識には「(共通)」を付す)
 *   - entries: 自スコープの全エントリ + 他スコープの共通エントリ
 */
async function view(boardId: string | null): Promise<{
  labelOf: Map<string, string>;
  entries: KnowledgeEntry[];
}> {
  const own = ownerScope(boardId);
  const scopes = [COMMON_SCOPE, ...(await listBoards()).map((b) => b.id)];
  const labelOf = new Map<string, string>();
  const entries: KnowledgeEntry[] = [];

  for (const scope of new Set([own, ...scopes])) {
    const foreign = scope !== own;
    const scoped = await readEntries(scope);
    entries.push(...(foreign ? scoped.filter((e) => e.common) : scoped));
    for (const s of await readSources(scope)) {
      if (!s.enabled) continue;
      labelOf.set(
        s.id,
        foreign && boardId !== null ? `${s.fileName}(共通)` : s.fileName,
      );
    }
  }
  return { labelOf, entries };
}

/** 知識ベースの全体像(このビューの資料一覧、AI から見えるカテゴリ別エントリ数) */
export async function getKnowledgeState(
  boardId: string | null,
): Promise<KnowledgeState> {
  const [sources, { labelOf, entries }] = await Promise.all([
    readSources(ownerScope(boardId)),
    view(boardId),
  ]);
  return { sources, categories: summarize(labelOf, entries) };
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
 * 原資料の保存 → Markdown 化 → LLM でドメイン知識を抽出 → skill を再レンダリング。
 * 各エントリの業務固有/業務横断は AI が判定する(共通管理画面からの追加は常に共通)。
 */
export async function addSource(
  boardId: string | null,
  fileName: string,
  buffer: Buffer,
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

  const scope = ownerScope(boardId);
  const id = newId();
  await saveOriginal(scope, id, fileName, buffer);

  const sources = await readSources(scope);
  const entries = await readEntries(scope);
  sources.push({
    id,
    fileName,
    enabled: true,
    entryCount: extracted.length,
    uploadedAt: new Date().toISOString(),
  });
  for (const e of extracted) {
    // 共通管理画面からの追加は業務が無いため必ず共通知識になる
    entries.push({ id: newId(), sourceId: id, ...e, common: boardId === null ? true : e.common });
  }
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await rerender(scope);
  return getKnowledgeState(boardId);
}

/**
 * 保存済みの原ファイルからドメイン知識を再抽出する
 * (抽出プロンプトの改善後などに、取り込みをやり直すため)。
 */
export async function reextractSource(
  boardId: string | null,
  sourceId: string,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
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
    entries.push({ id: newId(), sourceId, ...e, common: boardId === null ? true : e.common });
  }
  meta.entryCount = extracted.length;
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await rerender(scope);
  return getKnowledgeState(boardId);
}

// ---- ソースの操作 -----------------------------------------------------------

export async function setSourceEnabled(
  boardId: string | null,
  sourceId: string,
  enabled: boolean,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const sources = await readSources(scope);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error("指定の資料が見つかりません");
  source.enabled = enabled;
  await writeJson(sourcesFile(scope), sources);
  await rerender(scope);
  return getKnowledgeState(boardId);
}

export async function deleteSource(
  boardId: string | null,
  sourceId: string,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const sources = await readSources(scope);
  if (!sources.some((s) => s.id === sourceId)) {
    throw new Error("指定の資料が見つかりません");
  }
  const entries = (await readEntries(scope)).filter(
    (e) => e.sourceId !== sourceId,
  );
  await removeSourceDir(scope, sourceId);
  await writeJson(sourcesFile(scope), sources.filter((s) => s.id !== sourceId));
  await writeJson(knowledgeFile(scope), entries);
  await rerender(scope);
  return getKnowledgeState(boardId);
}

// ---- 閲覧(出典確認・カテゴリビュー) ---------------------------------------

/** カテゴリの知識(このビューから見える有効ソース由来)を閲覧用 Markdown で返す */
export async function getCategoryMarkdown(
  boardId: string | null,
  category: KnowledgeCategory,
): Promise<{ label: string; markdown: string }> {
  const def = CATEGORIES.find((c) => c.category === category);
  if (!def) throw new Error("指定のカテゴリが見つかりません");
  const { labelOf, entries } = await view(boardId);
  const body = renderCategoryBody(category, labelOf, entries);
  return {
    label: def.label,
    markdown: body || "(このカテゴリの知識はまだありません)",
  };
}

/** ソース 1 件から抽出されたエントリを閲覧用 Markdown で返す(出典確認用) */
export async function getSourceMarkdown(
  boardId: string | null,
  sourceId: string,
): Promise<{ meta: SourceMeta; markdown: string }> {
  const scope = ownerScope(boardId);
  const meta = (await readSources(scope)).find((s) => s.id === sourceId);
  if (!meta) throw new Error("指定の資料が見つかりません");
  const own = (await readEntries(scope)).filter((e) => e.sourceId === sourceId);
  const markdown = CATEGORIES.map((c) => {
    const list = own.filter((e) => e.category === c.category);
    if (list.length === 0) return null;
    return `# ${c.label}\n\n${list
      .map(
        (e) =>
          `## ${e.title}${e.common ? "(業務横断の共通知識)" : ""}\n\n${e.content}`,
      )
      .join("\n\n")}`;
  })
    .filter((s): s is string => s !== null)
    .join("\n\n");
  return { meta, markdown: markdown || "(抽出されたエントリがありません)" };
}

// ---- 内部 ----------------------------------------------------------------

/** スコープの変更を skill へ反映する(共通知識は全スコープの合成なので常に作り直す) */
async function rerender(scope: string): Promise<void> {
  if (scope !== COMMON_SCOPE) await renderSkills(scope);
  await renderCommonSkills();
}

function newId(): string {
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function summarize(
  labelOf: Map<string, string>,
  entries: KnowledgeEntry[],
): KnowledgeCategorySummary[] {
  return CATEGORIES.map((c) => ({
    category: c.category,
    label: c.label,
    count: entries.filter(
      (e) => e.category === c.category && labelOf.has(e.sourceId),
    ).length,
  }));
}
