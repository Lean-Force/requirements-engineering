// ドメイン知識ベースのユースケース。
//
// すべての資料・知識は全ボード共有(COMMON_SCOPE に集約)。
// どのボードからアップロードしても同じ場所に保存され、全ボードから参照できる。
//
//   workspaces/_common/
//     sources.json / knowledge.json / sources/<id>/<原ファイル>
//     map-snippets/<boardId>.md  … 確定マップ断片のキャッシュ
//
// AI へは buildKnowledgeContext が system prompt 用の全文テキストを組み立てて渡す。
// 永続化は repository.ts。
// エントリは出典(sourceId)を保持する。同じタイトルが複数ソースから来た場合は
// 両論併記で出典を明示する(勝手に統合して情報を落とさない)。

import { promises as fs } from "fs";
import path from "path";
import type {
  BoardMeta,
  ContextSize,
  EntryPatch,
  EntryRevision,
  KnowledgeCategory,
  KnowledgeCategorySummary,
  KnowledgeConflict,
  KnowledgeEntry,
  KnowledgeState,
  SourceMeta,
} from "@/contracts";
import {
  detectConflicts,
  detectNewBusiness,
  extractKnowledgeMulti,
  isConfigured,
  reviseEntry,
} from "../agent";
import type { DetectedBusiness, DetectedConflict, ExtractedEntry } from "../agent";
import { createBoard, listBoards } from "../boards";
import { isSupportedFile, parseFile } from "./parse";
import {
  conflictsFile,
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
import { CATEGORIES, renderCategoryBody, renderSkill, syncSkillsDir } from "./skills";
import { confirmedMapSections } from "./map-skills";
import { loadStoryMap } from "../storage";
import type { StoryMap } from "@/domain";
import { COMMON_SCOPE, workspaceDir } from "./workspace";

// ---- 読み取り --------------------------------------------------------------
//
// すべて COMMON_SCOPE に集約。boardId の違いは buildBoardContext でマップを
// 添える際のみ使う。知識・資料は常に共有。

/** すべての知識・資料は共通スコープに集約する */
const ownerScope = (_boardId: string | null): string => COMMON_SCOPE;

/**
 * ビューから見える知識を集める(単一スコープ)。
 */
async function view(_boardId: string | null): Promise<{
  labelOf: Map<string, string>;
  entries: KnowledgeEntry[];
}> {
  const entries = await readEntries(COMMON_SCOPE);
  const labelOf = new Map<string, string>();
  for (const s of await readSources(COMMON_SCOPE)) {
    if (!s.enabled) continue;
    labelOf.set(s.id, s.fileName);
  }
  return { labelOf, entries };
}

/** 知識ベースの全体像(このビューの資料一覧、AI から見えるカテゴリ別エントリ数) */
export async function getKnowledgeState(
  boardId: string | null,
): Promise<KnowledgeState> {
  const [sources, conflicts, proposals, { labelOf, entries }, block] =
    await Promise.all([
      readSources(ownerScope(boardId)),
      readConflicts(ownerScope(boardId)),
      readProposals(ownerScope(boardId)),
      view(boardId),
      buildBoardContext(boardId),
    ]);
  return {
    sources,
    categories: summarize(labelOf, entries),
    conflicts,
    proposals,
    contextSize: measureContext(block),
  };
}

/**
 * 注入テキストのサイズを見積もる。トークンは ASCII 4 文字 ≈ 1、
 * それ以外(日本語等)1 文字 ≈ 1 の概算(監視用途には十分)。
 * 上限は CONTEXT_WINDOW_TOKENS(既定 200,000 = Claude の標準)で標準化する。
 */
function measureContext(block: string): ContextSize {
  let ascii = 0;
  for (const ch of block) if (ch.charCodeAt(0) < 128) ascii++;
  const nonAscii = [...block].length - ascii;
  return {
    chars: [...block].length,
    tokens: Math.ceil(ascii / 4) + nonAscii,
    windowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS || 200_000),
  };
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
 * 各エントリの業務固有/業務横断は AI が判定する(boardId = null は互換経路で常に共通)。
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

  // LLM でドメイン知識エントリへ分解する(失敗したら取り込み自体を失敗させる)。
  // 既存知識をコンテキストとして渡し、表記・用語を既存の正に合わせる
  const extracted = await extractKnowledgeMulti(
    fileName,
    markdown,
    await buildBoardContext(boardId),
  );
  if (extracted.length === 0) {
    throw new Error(
      `ドメイン知識を抽出できませんでした: ${fileName}(内容を確認してください)`,
    );
  }
  return applySource(boardId, fileName, buffer, extracted);
}

/**
 * 抽出済みエントリを資料として適用する(LLM を呼ばない後段)。
 * 同名は資料の更新(✍️ 修正済みは保持)、スコープ方針の強制、矛盾・新業務スキャン
 * の呼び出しまでを担う。テストはここへリテラルの抽出結果を渡して検証する。
 */
export async function applySource(
  boardId: string | null,
  fileName: string,
  buffer: Buffer,
  extracted: ExtractedEntry[],
): Promise<KnowledgeState> {
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
    common: true,
  }));
  entries.push(...added);
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
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

  const extracted = await extractKnowledgeMulti(
    meta.fileName,
    markdown,
    await buildBoardContext(boardId),
  );
  if (extracted.length === 0) {
    throw new Error(`ドメイン知識を抽出できませんでした: ${meta.fileName}`);
  }
  return applyReextraction(boardId, sourceId, extracted);
}

/**
 * 再抽出結果を適用する(LLM を呼ばない後段)。
 * 人が(AI と協働で)直したエントリ(edited)は上書きしない(知識版の確定ロック)。
 */
export async function applyReextraction(
  boardId: string | null,
  sourceId: string,
  extracted: ExtractedEntry[],
): Promise<KnowledgeState> {
  const scope = ownerScope(boardId);
  const sources = await readSources(scope);
  const meta = sources.find((s) => s.id === sourceId);
  if (!meta) throw new Error("指定の資料が見つかりません");

  const all = await readEntries(scope);
  const kept = all.filter((e) => e.sourceId === sourceId && e.edited);
  const entries = all.filter((e) => e.sourceId !== sourceId);
  entries.push(...kept);
  for (const e of extracted) {
    entries.push({
      id: newId(),
      sourceId,
      ...e,
      common: true,
    });
  }
  meta.entryCount = kept.length + extracted.length;
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
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
  // LLM 未設定(ローカルのユニットテスト等)では検出しない
  if (!isConfigured()) return;
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

    if (blocks.length === 0 || newEntries.length === 0) {
      await recordConflicts(boardId, sourceId, fileName, []);
      return;
    }
    const newText = newEntries.map((e) => `${e.title}: ${e.content}`).join("\n");
    const detected = await detectConflicts(fileName, newText, blocks.join("\n"));
    await recordConflicts(boardId, sourceId, fileName, detected);
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

/**
 * 検出済みの矛盾を永続化する(LLM を呼ばない後段)。
 * この資料に関する既存の矛盾は洗い直し、既存側の出典ラベルを id に解決する。
 */
export async function recordConflicts(
  boardId: string | null,
  sourceId: string,
  fileName: string,
  detected: DetectedConflict[],
): Promise<void> {
  const scope = ownerScope(boardId);
  const remaining = (await readConflicts(scope)).filter(
    (c) => c.newSourceId !== sourceId,
  );
  const { labelOf } = await view(boardId);
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
  // LLM 未設定(ローカルのユニットテスト等)では検知しない
  if (!isConfigured()) return;
  try {
    if (newEntries.length === 0) {
      await recordBoardProposal(boardId, sourceId, fileName, {
        isNewBusiness: false,
        name: "",
        reason: "",
      });
      return;
    }
    const boards = await listBoards();
    const intake =
      boardId === null
        ? "共通スコープ(特定の業務に紐づかない)"
        : `業務「${boards.find((b) => b.id === boardId)?.name ?? boardId}」のボード`;
    const detected = await detectNewBusiness(
      fileName,
      newEntries.map((e) => `${e.title}: ${e.content}`).join("\n"),
      intake,
      await buildBoardContext(boardId),
    );
    await recordBoardProposal(boardId, sourceId, fileName, detected);
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
 * 新業務の判定結果を提案として永続化する(LLM を呼ばない後段)。
 * この資料の既存提案は洗い直す。isNewBusiness = false は提案なしとして記録。
 */
export async function recordBoardProposal(
  boardId: string | null,
  sourceId: string,
  fileName: string,
  detected: DetectedBusiness,
): Promise<void> {
  const scope = ownerScope(boardId);
  const remaining = (await readProposals(scope)).filter(
    (p) => p.sourceId !== sourceId,
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
}

/**
 * ボード作成提案を受け入れる: ボードを作成する。
 * 資料は共通スコープに残り、全ボードから参照できる。
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

// ---- チャットからの知識操作 ---------------------------------------------------

/** チャット由来の知識をまとめる組み込みソースの id / 表示名 */
const CHAT_SOURCE_ID = "src-chat";
const CHAT_SOURCE_NAME = "チャットでの決定";

/**
 * この業務で編集できるエントリの一覧(チャットの知識ツール用)。
 * 自スコープのエントリのみ(他業務由来の共通知識はここからは編集できない)。
 */
export async function listOwnEntries(boardId: string | null): Promise<
  {
    id: string;
    sourceId: string;
    category: KnowledgeCategory;
    title: string;
    content: string;
    common: boolean;
    edited: boolean;
    source: string;
  }[]
> {
  const scope = ownerScope(boardId);
  const sources = new Map((await readSources(scope)).map((s) => [s.id, s.fileName]));
  return (await readEntries(scope)).map((e) => ({
    id: e.id,
    sourceId: e.sourceId,
    category: e.category,
    title: e.title,
    content: e.content,
    common: e.common,
    edited: e.edited === true,
    source: sources.get(e.sourceId) ?? "(不明な資料)",
  }));
}

/**
 * 会話で確定した決定・定義を知識として追加する(出典 =「チャットでの決定」)。
 * 人の合意によるものなので edited = true(再抽出の概念がなく、上書きされない)。
 */
export async function addChatKnowledge(
  boardId: string | null,
  entry: { category: KnowledgeCategory; title: string; content: string; common?: boolean },
): Promise<KnowledgeEntry> {
  const scope = ownerScope(boardId);
  const sources = await readSources(scope);
  let source = sources.find((s) => s.id === CHAT_SOURCE_ID);
  if (!source) {
    source = {
      id: CHAT_SOURCE_ID,
      fileName: CHAT_SOURCE_NAME,
      enabled: true,
      entryCount: 0,
      uploadedAt: new Date().toISOString(),
    };
    sources.push(source);
    // 出典ビューア用に、実体の説明を原資料として置いておく
    await saveOriginal(
      scope,
      CHAT_SOURCE_ID,
      CHAT_SOURCE_NAME,
      Buffer.from("チャットでの合意により追加された知識(原資料はありません)"),
    );
  }
  const entries = await readEntries(scope);
  const added: KnowledgeEntry = {
    id: newId(),
    sourceId: CHAT_SOURCE_ID,
    category: entry.category,
    title: entry.title,
    content: entry.content,
    common: true,
    edited: true,
  };
  entries.push(added);
  source.entryCount = entries.filter((e) => e.sourceId === CHAT_SOURCE_ID).length;
  source.uploadedAt = new Date().toISOString();
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), entries);
  return added;
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
  return reviseEntry(
    meta.fileName,
    markdown,
    entry,
    instruction,
    await buildBoardContext(boardId),
  );
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
  entry.common = true;
  entry.edited = true;
  await writeJson(knowledgeFile(scope), entries);
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
  return getKnowledgeState(boardId);
}

// ---- AI への提示(チャット = skills + 常時注入 / 知識管理 = 全文注入) ---------

/**
 * チャット(と付箋の推敲)が常時注入するコンテキストを組み立てる:
 *   業務(ボード)一覧 + 各業務の合意済みマップ + 現在の User Story Map。
 * ドメイン知識はここに入れない — kb-* skill(syncKnowledgeSkills)として
 * ワークスペースへ同期され、AI が必要と判断したときだけ読まれる。
 * 合意済みマップはボード間の齟齬チェックに常時使うため注入に残す。
 * currentMap を渡すとそれを使う(チャットはミューテックス内のスナップショットを渡す)。
 */
export async function buildChatContext(
  boardId: string,
  currentMap?: StoryMap,
): Promise<string> {
  const sections: string[] = [];

  const boards = await listBoards();
  if (boards.length > 0) {
    sections.push(
      `# 業務(ボード)一覧\n${boards
        .map((b) => `- ${b.name}${b.id === boardId ? "(現在のボード)" : ""}`)
        .join("\n")}`,
    );
  }

  const maps = await confirmedMapSections();
  if (maps.length > 0) {
    sections.push(
      `# 各業務の合意済みマップ(確定 = チーム合意。「なぜなら」以降は合意された理由)\n\n${maps
        .map((m) => `## 業務: ${m.name}\n\n${m.body}`)
        .join("\n\n")}`,
    );
  }

  const map = currentMap ?? (await loadStoryMap(boardId));
  sections.push(
    `# 現在の User Story Map(この業務の現状)\n\n${JSON.stringify(map)}`,
  );
  return sections.join("\n\n");
}

/**
 * ドメイン知識をボードのワークスペースへ kb-* skill として同期する。
 * チャット・推敲の直前に呼ぶ(知識は全ボード共有のため、内容はどのボードでも同じ)。
 */
export async function syncKnowledgeSkills(boardId: string): Promise<void> {
  const { labelOf, entries } = await view(boardId);
  const skills = CATEGORIES.map((c) =>
    renderSkill(c.category, labelOf, entries),
  ).filter((s): s is { name: string; markdown: string } => s !== null);
  await syncSkillsDir(
    path.join(workspaceDir(boardId), ".claude", "skills"),
    skills,
  );
}

/**
 * 知識管理系の AI 行動(抽出・エントリ修正・業務判定)が注入する
 * 「標準コンテキストブロック」を組み立てる:
 *   業務(ボード)一覧 + ドメイン知識(全文) + 各業務の確定済みマップ
 *   + 現在の User Story Map(ボードのとき)。
 * これらは知識そのものが作業対象のため、skills ではなく全文を渡す。
 */
export async function buildBoardContext(
  boardId: string | null,
  currentMap?: StoryMap,
): Promise<string> {
  const sections: string[] = [];

  const boards = await listBoards();
  if (boards.length > 0) {
    sections.push(
      `# 業務(ボード)一覧\n${boards
        .map((b) => `- ${b.name}${b.id === boardId ? "(現在のボード)" : ""}`)
        .join("\n")}`,
    );
  }

  const knowledge = await buildKnowledgeContext(boardId);
  if (knowledge) sections.push(knowledge);

  if (boardId !== null) {
    const map = currentMap ?? (await loadStoryMap(boardId));
    sections.push(
      `# 現在の User Story Map(この業務の現状)\n\n${JSON.stringify(map)}`,
    );
  }
  return sections.join("\n\n");
}

/**
 * 知識部分の参照情報: 全ボード共有のドメイン知識 +
 * 各業務の確定済みマップ。無ければ空文字。出典(資料名)付き。
 */
export async function buildKnowledgeContext(boardId: string | null): Promise<string> {
  const { labelOf, entries } = await view(boardId);

  const sections: string[] = [];
  const bodies = CATEGORIES.map((c) => {
    const body = renderCategoryBody(c.category, labelOf, entries);
    return body ? `## ${c.label}\n\n${body.replace(/^## /gm, "### ")}` : null;
  }).filter((b): b is string => b !== null);
  if (bodies.length > 0) sections.push(`# ドメイン知識\n\n${bodies.join("\n\n")}`);

  const maps = await confirmedMapSections();
  if (maps.length > 0) {
    sections.push(
      `# 各業務の合意済みマップ(確定 = チーム合意。「なぜなら」以降は合意された理由)\n\n${maps
        .map((m) => `## 業務: ${m.name}\n\n${m.body}`)
        .join("\n\n")}`,
    );
  }
  return sections.join("\n\n");
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
