// 知識ベースの永続化(ファイルパスの解決と JSON の読み書きだけを担う)。
// ビジネスロジック(抽出・レンダリング・マージ方針)は knowledge.ts / skills.ts に置く。

import { promises as fs } from "fs";
import path from "path";
import type { KnowledgeEntry, SourceMeta } from "@/contracts";
import { workspaceDir } from "./workspace";

export const sourcesFile = (scope: string) =>
  path.join(workspaceDir(scope), "sources.json");
export const knowledgeFile = (scope: string) =>
  path.join(workspaceDir(scope), "knowledge.json");
export const sourceDir = (scope: string, id: string) =>
  path.join(workspaceDir(scope), "sources", id);
export const skillsRoot = (scope: string) =>
  path.join(workspaceDir(scope), ".claude", "skills");

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
export const readEntries = (scope: string) =>
  readJson<KnowledgeEntry[]>(knowledgeFile(scope), []);

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

/**
 * 原資料ディレクトリをスコープ間で移動する(業務 ⇄ 共通の付け替え用)。
 * 原資料が無い場合(旧形式のデータなど)はスキップする。
 */
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
