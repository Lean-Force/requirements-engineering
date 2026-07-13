// インフラ層: 論点(議論ポイント)の永続化と操作。
//
// ストーリー・タスク・ステップ(activity)・ボード全体に付ける「議論すべきこと」の
// メモ。解決時に「結論と理由」を必須にすることで、解決済みの論点がそのまま
// 合意の記録(rationale)になる。
//
// マップ本体(session.json)とは分けて workspaces/<boardId>/discussions.json に
// 置く。マップに埋め込まない理由:
//   - チャットの structured output(マップ全体)を太らせない
//   - AI がマップ更新時に論点を消したり書き換えたりできない(手動のみの方針)
// 要素の削除で宙に浮いた論点は、一覧時に現在のマップと突き合わせて掃除する。

import { promises as fs } from "fs";
import path from "path";
import type { DiscussionPoint, DiscussionTarget } from "@/contracts";
import type { StoryMap } from "@/domain";
import { workspaceDir } from "./context/workspace";
import { loadStoryMap } from "./storage";

const file = (boardId: string) =>
  path.join(workspaceDir(boardId), "discussions.json");

async function readAll(boardId: string): Promise<DiscussionPoint[]> {
  try {
    return JSON.parse(await fs.readFile(file(boardId), "utf-8")) as DiscussionPoint[];
  } catch {
    return [];
  }
}

async function writeAll(boardId: string, points: DiscussionPoint[]): Promise<void> {
  await fs.mkdir(workspaceDir(boardId), { recursive: true });
  await fs.writeFile(file(boardId), JSON.stringify(points, null, 2), "utf-8");
}

/** マップ上に存在する要素 id の集合(孤児判定用) */
function elementIds(map: StoryMap): Set<string> {
  const ids = new Set<string>();
  for (const act of map.activities) {
    ids.add(act.id);
    for (const a of act.actions) {
      ids.add(a.id);
      for (const s of a.stories) ids.add(s.id);
    }
  }
  return ids;
}

/**
 * 論点の一覧。要素の削除で対象を失った論点(孤児)はここで掃除して永続化する
 * (board 対象は常に有効)。
 */
export async function listDiscussions(
  boardId: string,
  map?: StoryMap,
): Promise<DiscussionPoint[]> {
  const points = await readAll(boardId);
  const current = map ?? (await loadStoryMap(boardId));
  const ids = elementIds(current);
  const alive = points.filter(
    (p) => p.target.kind === "board" || ids.has(p.target.id),
  );
  if (alive.length !== points.length) await writeAll(boardId, alive);
  return alive;
}

/** 論点を追加する(open で作られる) */
export async function addDiscussion(
  boardId: string,
  target: DiscussionTarget,
  text: string,
): Promise<DiscussionPoint> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("論点の内容が空です");
  const point: DiscussionPoint = {
    id: `disc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    target,
    text: trimmed,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  const points = await readAll(boardId);
  points.push(point);
  await writeAll(boardId, points);
  return point;
}

/** 論点を解決する。結論と理由(resolution)は必須 = 合意の記録 */
export async function resolveDiscussion(
  boardId: string,
  discussionId: string,
  resolution: string,
): Promise<DiscussionPoint> {
  const trimmed = resolution.trim();
  if (!trimmed) throw new Error("結論(どう決めたか・なぜか)が空です");
  const points = await readAll(boardId);
  const point = points.find((p) => p.id === discussionId);
  if (!point) throw new Error("指定の論点が見つかりません");
  point.status = "resolved";
  point.resolution = trimmed;
  point.resolvedAt = new Date().toISOString();
  await writeAll(boardId, points);
  return point;
}

/** 解決済みの論点を未解決へ戻す(結論は残す = 再燃の経緯が分かる) */
export async function reopenDiscussion(
  boardId: string,
  discussionId: string,
): Promise<DiscussionPoint> {
  const points = await readAll(boardId);
  const point = points.find((p) => p.id === discussionId);
  if (!point) throw new Error("指定の論点が見つかりません");
  point.status = "open";
  delete point.resolvedAt;
  await writeAll(boardId, points);
  return point;
}

/** 論点を削除する */
export async function deleteDiscussion(
  boardId: string,
  discussionId: string,
): Promise<void> {
  const points = await readAll(boardId);
  if (!points.some((p) => p.id === discussionId)) {
    throw new Error("指定の論点が見つかりません");
  }
  await writeAll(boardId, points.filter((p) => p.id !== discussionId));
}

/**
 * チャットの常時注入用テキスト。対象要素の本文をラベルにして、
 * 未解決(議論の文脈)と解決済み(合意の記録)を分けて描画する。無ければ空文字。
 */
export async function renderDiscussions(
  boardId: string,
  map: StoryMap,
): Promise<string> {
  const points = await listDiscussions(boardId, map);
  if (points.length === 0) return "";

  const label = (t: DiscussionTarget): string => {
    if (t.kind === "board") return "ボード全体";
    for (const act of map.activities) {
      if (t.kind === "activity" && act.id === t.id) {
        const name = act.actions.map((a) => a.text).join("/") || act.id;
        return `ステップ「${name}」`;
      }
      for (const a of act.actions) {
        if (t.kind === "action" && a.id === t.id) return `タスク「${a.text}」`;
        if (t.kind === "story") {
          const s = a.stories.find((x) => x.id === t.id);
          if (s) return `ストーリー「${s.text}」`;
        }
      }
    }
    return t.id; // listDiscussions で掃除済みのため通常は到達しない
  };

  const open = points.filter((p) => p.status === "open");
  const resolved = points.filter((p) => p.status === "resolved");
  const lines: string[] = ["# この業務の論点(手動管理。AI は変更できない)"];
  if (open.length > 0) {
    lines.push(
      "## 未解決(提案・回答の際に踏まえる。関係する要素を確定扱いしない)",
      ...open.map((p) => `- [${label(p.target)}] ${p.text}`),
    );
  }
  if (resolved.length > 0) {
    lines.push(
      "## 解決済み(チームの合意。結論に沿う)",
      ...resolved.map((p) => `- [${label(p.target)}] ${p.text} → 結論: ${p.resolution}`),
    );
  }
  return lines.join("\n");
}
