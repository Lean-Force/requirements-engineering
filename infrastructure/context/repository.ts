// 知識ベースの永続化(ファイルパスの解決と JSON の読み書きだけを担う)。
// ビジネスロジック(抽出・レンダリング・マージ方針)は knowledge.ts / skills.ts に置く。

import { promises as fs } from "fs";
import path from "path";
import type { BoardProposal, KnowledgeConflict, KnowledgeEntry, SourceMeta } from "@/contracts";
import { COMMON_SCOPE, workspaceDir } from "./workspace";

export const sourcesFile = (scope: string) =>
  path.join(workspaceDir(scope), "sources.json");
export const knowledgeFile = (scope: string) =>
  path.join(workspaceDir(scope), "knowledge.json");
export const sourceDir = (scope: string, id: string) =>
  path.join(workspaceDir(scope), "sources", id);
export const skillsRoot = (scope: string) =>
  path.join(workspaceDir(scope), ".claude", "skills");
export const conflictsFile = (scope: string) =>
  path.join(workspaceDir(scope), "conflicts.json");
export const proposalsFile = (scope: string) =>
  path.join(workspaceDir(scope), "board-proposals.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

export const readSources = (scope: string) =>
  readJson<SourceMeta[]>(sourcesFile(scope), []);

export const readConflicts = (scope: string) =>
  readJson<KnowledgeConflict[]>(conflictsFile(scope), []);
export const readProposals = (scope: string) =>
  readJson<BoardProposal[]>(proposalsFile(scope), []);

/**
 * エントリの読み取り。common フラグが無い旧データは
 * 「共通スコープ由来なら共通、それ以外は業務固有」として補完する。
 */
export const readEntries = async (scope: string): Promise<KnowledgeEntry[]> => {
  const entries = await readJson<KnowledgeEntry[]>(knowledgeFile(scope), []);
  return entries.map((e) =>
    typeof e.common === "boolean" ? e : { ...e, common: scope === COMMON_SCOPE },
  );
};

/** 原資料の保存(再抽出・出典確認用) */
export async function saveOriginal(
  scope: string,
  id: string,
  fileName: string,
  buffer: Buffer,
): Promise<void> {
  await fs.mkdir(sourceDir(scope, id), { recursive: true });
  await fs.writeFile(path.join(sourceDir(scope, id), fileName), buffer);
}

export async function readOriginal(
  scope: string,
  id: string,
  fileName: string,
): Promise<Buffer> {
  return fs.readFile(path.join(sourceDir(scope, id), fileName));
}

export async function removeSourceDir(scope: string, id: string): Promise<void> {
  await fs.rm(sourceDir(scope, id), { recursive: true, force: true });
}

/** 原資料ディレクトリをスコープ間で移動する(無ければスキップ = 旧データ耐性) */
export async function moveSourceDir(
  fromScope: string,
  toScope: string,
  id: string,
): Promise<void> {
  const dest = sourceDir(toScope, id);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(sourceDir(fromScope, id), dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
