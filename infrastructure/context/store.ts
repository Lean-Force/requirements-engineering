// インフラ層: コンテキスト(参照資料)の保存先。
//
// 資料は Agent Skill としてワークスペースに保存する:
//   data/workspace/
//     contexts.json                  ← メタ情報の索引(ContextDocMeta[])
//     .claude/skills/<id>/SKILL.md   ← frontmatter(name/description) + 本文 Markdown
//
// SKILL.md の description は常に AI へ提示され、本文は AI が必要と
// 判断したときだけ読み込まれる(Agent SDK の progressive disclosure)。
// on/off は索引の enabled で管理し、有効な skill 名だけを query() に渡す。

import { promises as fs } from "fs";
import path from "path";
import type { ContextDocMeta } from "@/contracts";
import { isSupportedFile, parseFile } from "./parse";

// CONTEXT_WORKSPACE で差し替え可能(E2E の隔離用)
export function workspaceDir(): string {
  return process.env.CONTEXT_WORKSPACE
    ? path.resolve(process.env.CONTEXT_WORKSPACE)
    : path.join(process.cwd(), "data", "workspace");
}

function indexFile(): string {
  return path.join(workspaceDir(), "contexts.json");
}

function skillDir(id: string): string {
  return path.join(workspaceDir(), ".claude", "skills", id);
}

async function readIndex(): Promise<ContextDocMeta[]> {
  try {
    const raw = await fs.readFile(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContextDocMeta[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(docs: ContextDocMeta[]): Promise<void> {
  await fs.mkdir(workspaceDir(), { recursive: true });
  await fs.writeFile(indexFile(), JSON.stringify(docs, null, 2), "utf-8");
}

// ---- 公開 API ------------------------------------------------------------

export async function listContexts(): Promise<ContextDocMeta[]> {
  return readIndex();
}

/** ファイル 1 つを 1 コンテキストとして取り込み、メタ一覧(全体)を返す */
export async function addContextsFromFile(
  fileName: string,
  buffer: Buffer,
): Promise<ContextDocMeta[]> {
  if (!isSupportedFile(fileName)) {
    throw new Error(
      `未対応のファイル形式です: ${fileName}(xlsx / xls / csv / pdf / md / txt に対応)`,
    );
  }

  const parsed = await parseFile(fileName, buffer);
  if (parsed.length === 0) {
    throw new Error(`内容が空のため取り込めませんでした: ${fileName}`);
  }

  // 複数シートは 1 つの SKILL.md にセクションとして畳む(1 ファイル = 1 skill)
  const markdown = parsed
    .map((d) => (d.sheetName ? `## シート: ${d.sheetName}\n\n${d.markdown}` : d.markdown))
    .join("\n\n");
  const description =
    parsed.length === 1
      ? parsed[0].description
      : `${parsed.length}シート(${parsed.map((d) => d.sheetName).join(" / ")})`;

  const docs = await readIndex();
  const meta: ContextDocMeta = {
    id: newId(),
    fileName,
    description,
    enabled: true,
    charCount: markdown.length,
    uploadedAt: new Date().toISOString(),
  };
  await writeSkill(meta, markdown);
  docs.push(meta);
  await writeIndex(docs);
  return docs;
}

export async function setContextEnabled(
  id: string,
  enabled: boolean,
): Promise<ContextDocMeta[]> {
  const docs = await readIndex();
  const doc = docs.find((d) => d.id === id);
  if (!doc) throw new Error("指定のコンテキストが見つかりません");
  doc.enabled = enabled;
  await writeIndex(docs);
  return docs;
}

export async function deleteContext(id: string): Promise<ContextDocMeta[]> {
  const docs = await readIndex();
  if (!docs.some((d) => d.id === id)) {
    throw new Error("指定のコンテキストが見つかりません");
  }
  await fs.rm(skillDir(id), { recursive: true, force: true });
  const next = docs.filter((d) => d.id !== id);
  await writeIndex(next);
  return next;
}

/** チャット時に query() の skills オプションへ渡す、有効な skill 名の一覧 */
export async function enabledSkillNames(): Promise<string[]> {
  return (await readIndex()).filter((d) => d.enabled).map((d) => d.id);
}

/** 変換後の本文(SKILL.md の frontmatter を除いた Markdown)を返す */
export async function getContextContent(
  id: string,
): Promise<{ meta: ContextDocMeta; markdown: string }> {
  const docs = await readIndex();
  const meta = docs.find((d) => d.id === id);
  if (!meta) throw new Error("指定のコンテキストが見つかりません");

  const raw = await fs.readFile(path.join(skillDir(id), "SKILL.md"), "utf-8");
  // 先頭の frontmatter(--- で囲まれたブロック)を取り除く
  const markdown = raw.replace(/^---\n[\s\S]*?\n---\n+/, "");
  return { meta, markdown };
}

// ---- 内部 ----------------------------------------------------------------

function newId(): string {
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function writeSkill(meta: ContextDocMeta, markdown: string): Promise<void> {
  // description は AI が「読むかどうか」を判断する唯一の手がかりなので、
  // 資料名と内容要約の両方を入れる。
  const skillMd = `---
name: ${meta.id}
description: 参照資料「${meta.fileName}」— ${meta.description}。ユーザーの業務・要件・用語に関わる整理でこの資料が関係しそうなときに読むこと。
---

# ${meta.fileName}

${markdown}
`;
  const dir = skillDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
}
