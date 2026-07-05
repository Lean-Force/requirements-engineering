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

import { promises as fs } from "fs";
import path from "path";
import type {
  BoardMeta,
  BoardProposal,
  EntryPatch,
  EntryRevision,
  KnowledgeCategory,
  KnowledgeCategorySummary,
  KnowledgeConflict,
  KnowledgeEntry,
  KnowledgeState,
  SourceMeta,
} from "@/contracts";
import { detectConflicts, detectNewBusiness, extractKnowledgeMulti, reviseEntry } from "../agent";
import { createBoard, listBoards } from "../boards";
import { isSupportedFile, parseFile } from "./parse";
import {
  conflictsFile,
  moveSourceDir,
  proposalsFile,
  readConflicts,
  readProposals,
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
import { COMMON_SCOPE, workspaceDir } from "./workspace";

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
  const [sources, conflicts, proposals, { labelOf, entries }] = await Promise.all([
    readSources(ownerScope(boardId)),
    readConflicts(ownerScope(boardId)),
    readProposals(ownerScope(boardId)),
    view(boardId),
  ]);
  return { sources, categories: summarize(labelOf, entries), conflicts, proposals };
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
  const extracted = await extractKnowledgeMulti(fileName, markdown);
  if (extracted.length === 0) {
    throw new Error(
      `ドメイン知識を抽出できませんでした: ${fileName}(内容を確認してください)`,
    );
  }

  const scope = ownerScope(boardId);
  const sources = await readSources(scope);
  let entries = await readEntries(scope);

  // 同名ファイルは「資料の更新」: 原資料を差し替えて再抽出し、
  // 人が直したエントリ(edited)は保持する(鮮度のハンドリング)
  const existing = sources.find((s) => s.fileName === fileName);
  const id = existing?.id ?? newId();
  await saveOriginal(scope, id, fileName, buffer);

  let kept: KnowledgeEntry[] = [];
  if (existing) {
    kept = entries.filter((e) => e.sourceId === id && e.edited);
    entries = entries.filter((e) => e.sourceId !== id);
    entries.push(...kept);
    existing.uploadedAt = new Date().toISOString();
    existing.entryCount = kept.length + extracted.length;
  } else {
    sources.push({
      id,
      fileName,
      enabled: true,
      entryCount: extracted.length,
      uploadedAt: new Date().toISOString(),
    });
  }
  const added: KnowledgeEntry[] = extracted.map((e) => ({
    id: newId(),
    sourceId: id,
    ...e,
    // 共通管理画面からの追加は業務が無いため必ず共通知識になる
    common: boardId === null ? true : e.common,
  }));
  entries.push(...added);
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await rerender(scope);
  await scanConflicts(boardId, id, fileName, [...kept, ...added]);
  await scanNewBusiness(boardId, id, fileName, added);
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

  const extracted = await extractKnowledgeMulti(meta.fileName, markdown);
  if (extracted.length === 0) {
    throw new Error(`ドメイン知識を抽出できませんでした: ${meta.fileName}`);
  }

  // このソース由来のエントリを差し替える。ただし人が(AI と協働で)直した
  // エントリ(edited)は再抽出で上書きしない(知識版の確定ロック)。
  const all = await readEntries(scope);
  const kept = all.filter((e) => e.sourceId === sourceId && e.edited);
  const entries = all.filter((e) => e.sourceId !== sourceId);
  entries.push(...kept);
  for (const e of extracted) {
    entries.push({ id: newId(), sourceId, ...e, common: boardId === null ? true : e.common });
  }
  meta.entryCount = kept.length + extracted.length;
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  await rerender(scope);
  await scanConflicts(
    boardId,
    sourceId,
    meta.fileName,
    entries.filter((e) => e.sourceId === sourceId),
  );
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
  await writeJson(
    conflictsFile(scope),
    (await readConflicts(scope)).filter(
      (c) => c.newSourceId !== sourceId && c.existingSourceId !== sourceId,
    ),
  );
  await writeJson(
    proposalsFile(scope),
    (await readProposals(scope)).filter((p) => p.sourceId !== sourceId),
  );
  await rerender(scope);
  return getKnowledgeState(boardId);
}

// ---- 矛盾の検出と解消 --------------------------------------------------------

/**
 * 取り込んだ資料のエントリを、既存知識(このビューの他資料 + 確定済みマップ)と
 * 突合して矛盾を検出・永続化する。検出失敗で取り込み自体は失敗させない(warn のみ)。
 */
async function scanConflicts(
  boardId: string | null,
  sourceId: string,
  fileName: string,
  newEntries: KnowledgeEntry[],
): Promise<void> {
  const scope = ownerScope(boardId);
  try {
    // 既存知識: このビューから見える、当該資料「以外」のエントリ(出典ラベル付き)
    const { labelOf, entries } = await view(boardId);
    const others = entries.filter(
      (e) => e.sourceId !== sourceId && labelOf.has(e.sourceId),
    );
    const blocks: string[] = others.map(
      (e) => `[出典: ${labelOf.get(e.sourceId)}] ${e.title}: ${e.content}`,
    );
    // 確定済みマップ(チーム合意)は最優先の既存知識として突合する
    if (boardId !== null) {
      const snippet = await fs
        .readFile(
          path.join(workspaceDir(COMMON_SCOPE), "map-snippets", `${boardId}.md`),
          "utf-8",
        )
        .catch(() => "");
      if (snippet) blocks.push(`[出典: 確定済みマップ(この業務の合意)] ${snippet}`);
    }

    // この資料に関する既存の矛盾は洗い直す(解消済みの残骸を残さない)
    const remaining = (await readConflicts(scope)).filter(
      (c) => c.newSourceId !== sourceId,
    );
    if (blocks.length === 0 || newEntries.length === 0) {
      await writeJson(conflictsFile(scope), remaining);
      return;
    }

    const newText = newEntries.map((e) => `${e.title}: ${e.content}`).join("\n");
    const detected = await detectConflicts(fileName, newText, blocks.join("\n"));
    const labelToId = new Map([...labelOf].map(([id, label]) => [label, id]));
    const conflicts: KnowledgeConflict[] = detected.map((d) => ({
      id: newId(),
      detectedAt: new Date().toISOString(),
      topic: d.topic,
      newSource: fileName,
      newClaim: d.newClaim,
      existingSource: d.existingSource,
      existingClaim: d.existingClaim,
      newSourceId: sourceId,
      existingSourceId: labelToId.get(d.existingSource),
    }));
    await writeJson(conflictsFile(scope), [...remaining, ...conflicts]);
  } catch (err) {
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        kind: "conflict-scan-failed",
        fileName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** 矛盾を解決済みにする(一覧から消す) */
export async function dismissConflict(
  boardId: string | null,
  conflictId: string,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const conflicts = await readConflicts(scope);
  if (!conflicts.some((c) => c.id === conflictId)) {
    throw new Error("指定の矛盾が見つかりません");
  }
  await writeJson(
    conflictsFile(scope),
    conflicts.filter((c) => c.id !== conflictId),
  );
  return getKnowledgeState(boardId);
}

// ---- 新しい業務の検知とボード作成提案 -----------------------------------------

/**
 * 取り込んだ資料が既存のどの業務でもない「新しい業務」なら、ボード作成の提案を
 * 永続化する(承認・却下はユーザー)。検知失敗で取り込みは失敗させない。
 */
async function scanNewBusiness(
  boardId: string | null,
  sourceId: string,
  fileName: string,
  newEntries: KnowledgeEntry[],
): Promise<void> {
  const scope = ownerScope(boardId);
  try {
    const remaining = (await readProposals(scope)).filter(
      (p) => p.sourceId !== sourceId,
    );
    if (newEntries.length === 0) {
      await writeJson(proposalsFile(scope), remaining);
      return;
    }
    const boards = await listBoards();
    const intake =
      boardId === null
        ? "共通知識の管理画面(特定の業務に紐づかない)"
        : `業務「${boards.find((b) => b.id === boardId)?.name ?? boardId}」のボード`;
    const detected = await detectNewBusiness(
      fileName,
      newEntries.map((e) => `${e.title}: ${e.content}`).join("\n"),
      boards.map((b) => b.name),
      intake,
    );
    if (detected.isNewBusiness && detected.name.trim()) {
      remaining.push({
        id: newId(),
        detectedAt: new Date().toISOString(),
        sourceId,
        fileName,
        name: detected.name.trim(),
        reason: detected.reason,
      });
    }
    await writeJson(proposalsFile(scope), remaining);
  } catch (err) {
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        kind: "business-detect-failed",
        fileName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * ボード作成提案を受け入れる: ボードを作成し、提案のもとになった資料
 * (メタ・エントリ・原資料)を新しいボードへ移して skill を作り直す。
 */
export async function acceptBoardProposal(
  boardId: string | null,
  proposalId: string,
): Promise<{ board: BoardMeta; state: KnowledgeState }> {
  const scope = ownerScope(boardId);
  const proposals = await readProposals(scope);
  const proposal = proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error("指定の提案が見つかりません");

  const board = await createBoard(proposal.name);

  // 資料一式を新ボードへ移す(資料が既に消えていれば作成だけ行う)
  const fromSources = await readSources(scope);
  const meta = fromSources.find((s) => s.id === proposal.sourceId);
  if (meta) {
    const fromEntries = await readEntries(scope);
    const own = fromEntries.filter((e) => e.sourceId === proposal.sourceId);
    await moveSourceDir(scope, board.id, proposal.sourceId);
    await writeJson(sourcesFile(board.id), [
      ...(await readSources(board.id)),
      meta,
    ]);
    await writeJson(knowledgeFile(board.id), [
      ...(await readEntries(board.id)),
      ...own,
    ]);
    await writeJson(
      sourcesFile(scope),
      fromSources.filter((s) => s.id !== proposal.sourceId),
    );
    await writeJson(
      knowledgeFile(scope),
      fromEntries.filter((e) => e.sourceId !== proposal.sourceId),
    );
    await renderSkills(board.id);
    await rerender(scope);
  }

  await writeJson(
    proposalsFile(scope),
    proposals.filter((p) => p.id !== proposalId),
  );
  return { board, state: await getKnowledgeState(boardId) };
}

/** ボード作成提案を却下する */
export async function dismissBoardProposal(
  boardId: string | null,
  proposalId: string,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const proposals = await readProposals(scope);
  if (!proposals.some((p) => p.id === proposalId)) {
    throw new Error("指定の提案が見つかりません");
  }
  await writeJson(
    proposalsFile(scope),
    proposals.filter((p) => p.id !== proposalId),
  );
  return getKnowledgeState(boardId);
}

// ---- エントリ単位の操作(AI と協働で直す) -----------------------------------

/** ソース 1 件の抽出エントリ一覧(編集 UI 用) */
export async function getSourceEntries(
  boardId: string | null,
  sourceId: string,
): Promise<{ meta: SourceMeta; entries: KnowledgeEntry[] }> {
  const scope = ownerScope(boardId);
  const meta = (await readSources(scope)).find((s) => s.id === sourceId);
  if (!meta) throw new Error("指定の資料が見つかりません");
  const entries = (await readEntries(scope)).filter((e) => e.sourceId === sourceId);
  return { meta, entries };
}

/**
 * エントリ 1 件の AI 修正案を作る(保存はしない)。
 * 原資料の全文を根拠として渡すので、指示が原文と食い違えば note で指摘される。
 */
export async function proposeEntryRevision(
  boardId: string | null,
  sourceId: string,
  entryId: string,
  instruction: string,
): Promise<EntryRevision> {
  const scope = ownerScope(boardId);
  const meta = (await readSources(scope)).find((s) => s.id === sourceId);
  if (!meta) throw new Error("指定の資料が見つかりません");
  const entry = (await readEntries(scope)).find(
    (e) => e.id === entryId && e.sourceId === sourceId,
  );
  if (!entry) throw new Error("指定のエントリが見つかりません");

  const buffer = await readOriginal(scope, sourceId, meta.fileName);
  const markdown = await toMarkdown(meta.fileName, buffer);
  return reviseEntry(meta.fileName, markdown, entry, instruction);
}

/** エントリ 1 件を保存する(edited = true になり、以後の再抽出で上書きされない) */
export async function updateEntry(
  boardId: string | null,
  sourceId: string,
  entryId: string,
  patch: EntryPatch,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const entries = await readEntries(scope);
  const entry = entries.find((e) => e.id === entryId && e.sourceId === sourceId);
  if (!entry) throw new Error("指定のエントリが見つかりません");
  entry.title = patch.title;
  entry.content = patch.content;
  // 共通管理画面のエントリは常に共通のまま
  entry.common = boardId === null ? true : patch.common;
  entry.edited = true;
  await writeJson(knowledgeFile(scope), entries);
  await rerender(scope);
  return getKnowledgeState(boardId);
}

/** エントリ 1 件を削除する(資料は残る。entryCount を追従) */
export async function deleteEntry(
  boardId: string | null,
  sourceId: string,
  entryId: string,
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const entries = await readEntries(scope);
  if (!entries.some((e) => e.id === entryId && e.sourceId === sourceId)) {
    throw new Error("指定のエントリが見つかりません");
  }
  const next = entries.filter((e) => e.id !== entryId);
  const sources = await readSources(scope);
  const meta = sources.find((s) => s.id === sourceId);
  if (meta) meta.entryCount = next.filter((e) => e.sourceId === sourceId).length;
  await writeJson(knowledgeFile(scope), next);
  await writeJson(sourcesFile(scope), sources);
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
