// インフラ層: ボード(= 業務)の一覧と作成。
//
// ボードは <DATA_DIR>/boards.json で管理し、各ボードの実体(マップ・会話・
// 版履歴・ドメイン知識)は workspaces/<boardId>/ に置く。
//
// 旧シングルボード形式(data/storymap.json + data/workspace/)が残っていた
// 場合は、初回アクセス時に「最初のボード」として自動移行する。

import { promises as fs } from "fs";
import path from "path";
import type { BoardMeta } from "@/contracts";
import { dataRoot, workspaceDir } from "./context/workspace";

function boardsFile(): string {
  return path.join(dataRoot(), "boards.json");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function newBoardId(): string {
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// 旧形式(シングルボード)からの移行。boards.json が無く、旧ファイルがあるときだけ動く。
async function migrateLegacy(): Promise<BoardMeta[]> {
  const legacySession = path.join(dataRoot(), "storymap.json");
  const legacyWorkspace = path.join(dataRoot(), "workspace");

  const boards: BoardMeta[] = [];
  if ((await exists(legacySession)) || (await exists(legacyWorkspace))) {
    const board: BoardMeta = {
      id: newBoardId(),
      name: "最初のボード",
      createdAt: new Date().toISOString(),
    };
    const dir = workspaceDir(board.id);
    await fs.mkdir(dir, { recursive: true });

    if (await exists(legacySession)) {
      await fs.rename(legacySession, path.join(dir, "session.json"));
    }
    if (await exists(legacyWorkspace)) {
      // 知識ベース一式(sources.json / knowledge.json / sources/ / .claude/)を移す
      for (const entry of await fs.readdir(legacyWorkspace)) {
        await fs.rename(
          path.join(legacyWorkspace, entry),
          path.join(dir, entry),
        );
      }
      await fs.rm(legacyWorkspace, { recursive: true, force: true });
    }
    boards.push(board);
  }
  return boards;
}

async function readBoards(): Promise<BoardMeta[]> {
  try {
    const raw = await fs.readFile(boardsFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BoardMeta[]) : [];
  } catch {
    // boards.json がまだ無い → 旧形式があれば移行し、無ければ空で初期化
    const boards = await migrateLegacy();
    await writeBoards(boards);
    return boards;
  }
}

async function writeBoards(boards: BoardMeta[]): Promise<void> {
  await fs.mkdir(dataRoot(), { recursive: true });
  await fs.writeFile(boardsFile(), JSON.stringify(boards, null, 2), "utf-8");
}

// ---- 公開 API ------------------------------------------------------------

export async function listBoards(): Promise<BoardMeta[]> {
  return readBoards();
}

export async function createBoard(name: string): Promise<BoardMeta> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("ボード名を入力してください");

  const boards = await readBoards();
  const board: BoardMeta = {
    id: newBoardId(),
    name: trimmed,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(workspaceDir(board.id), { recursive: true });
  boards.push(board);
  await writeBoards(boards);
  return board;
}

/** ボードの存在確認つき取得(無ければ throw) */
export async function getBoard(id: string): Promise<BoardMeta> {
  const board = (await readBoards()).find((b) => b.id === id);
  if (!board) throw new Error("指定のボードが見つかりません");
  return board;
}

/** ボード名(業務名)の変更 */
export async function renameBoard(id: string, name: string): Promise<BoardMeta> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("ボード名を入力してください");
  const boards = await readBoards();
  const board = boards.find((b) => b.id === id);
  if (!board) throw new Error("指定のボードが見つかりません");
  board.name = trimmed;
  await writeBoards(boards);
  return board;
}

/** ボードの削除(マップ・会話・版履歴・ドメイン知識ごと消す。共通知識は残る) */
export async function deleteBoard(id: string): Promise<void> {
  const boards = await readBoards();
  if (!boards.some((b) => b.id === id)) {
    throw new Error("指定のボードが見つかりません");
  }
  await fs.rm(workspaceDir(id), { recursive: true, force: true });
  await writeBoards(boards.filter((b) => b.id !== id));
}
