// インフラ層: ストーリーマップ・会話・版履歴の保存先。
//
// 保存先はポート(StoryMapRepository)で抽象化する。
//   - ローカル / E2E : FileStoryMapRepository(JSON ファイル)
// このモジュールは「版の重複排除・上限・連続編集の畳み込み」といった方針を一手に引き受け、
// 上位(app/api)へは用途別の関数として公開する。

import { normalizeStoryMap } from "@/domain";
import type { StoryMap } from "@/domain";
import type {
  BoardSession,
  ChatMessage,
  SessionState,
  StoryMapVersion,
  StoryMapVersionMeta,
} from "@/contracts";
import type { StoryMapRepository } from "./repository";
import { FileStoryMapRepository } from "./file-repository";

export type { StoryMapRepository } from "./repository";
export { FileStoryMapRepository } from "./file-repository";

// 版履歴の保持上限(最新 N 件だけ保持し、古いものから捨てる)と、会話の保持上限。
const MAX_VERSIONS = 10;
const MAX_MESSAGES = 400;

// 保存先実装。STORYMAP_FILE で保存ファイルを差し替えられる(E2E の隔離用)。
function repo(): StoryMapRepository {
  return new FileStoryMapRepository(process.env.STORYMAP_FILE);
}

function makeVersion(
  source: StoryMapVersion["source"],
  summary: string,
  storyMap: StoryMap,
): StoryMapVersion {
  return {
    id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    source,
    summary,
    storyMap,
  };
}

function toMeta(v: StoryMapVersion): StoryMapVersionMeta {
  const { storyMap: _omit, ...meta } = v;
  void _omit;
  return meta;
}

// 版履歴へスナップショットを積む(セッションを破壊的に更新)。
// 方針:
//   - 直前の版とマップが同一なら積まない(無変化)。
//   - 連続するボード編集(edit)は最新の 1 版に畳み込む(D&D 連打で履歴が溢れない)。
//   - それ以外は追記し、上限を超えたら古い版から捨てる。
function pushVersion(
  session: BoardSession,
  source: StoryMapVersion["source"],
  summary: string,
  storyMap: StoryMap,
): void {
  const last = session.versions[session.versions.length - 1];
  const mapJson = JSON.stringify(storyMap);
  if (last && JSON.stringify(last.storyMap) === mapJson) return;

  if (source === "edit" && last && last.source === "edit") {
    session.versions[session.versions.length - 1] = makeVersion(source, summary, storyMap);
    return;
  }

  session.versions.push(makeVersion(source, summary, storyMap));
  if (session.versions.length > MAX_VERSIONS) {
    session.versions = session.versions.slice(-MAX_VERSIONS);
  }
}

// ---- 公開 API ------------------------------------------------------------

// 現在のマップだけが欲しい場合(後方互換)。
export async function loadStoryMap(): Promise<StoryMap> {
  return (await repo().loadSession()).storyMap;
}

// 初期ロード用。マップ・会話・版一覧(メタ)をまとめて返す。
export async function loadSession(): Promise<SessionState> {
  const s = await repo().loadSession();
  return { storyMap: s.storyMap, messages: s.messages, versions: s.versions.map(toMeta) };
}

// ボード編集など、マップだけを保存する。版を 1 つ積んで最新の版一覧を返す。
export async function saveStoryMap(
  map: StoryMap,
  source: StoryMapVersion["source"] = "edit",
  summary = "ボードを編集",
): Promise<StoryMapVersionMeta[]> {
  const r = repo();
  const s = await r.loadSession();
  const normalized = normalizeStoryMap(map);
  pushVersion(s, source, summary, normalized);
  s.storyMap = normalized;
  await r.saveSession(s);
  return s.versions.map(toMeta);
}

// チャット 1 ターンを一括で反映(マップ更新 + 版追加 + 会話保存)を 1 回の保存で行う。
export async function applyChatTurn(
  map: StoryMap,
  reply: string,
  messages: ChatMessage[],
): Promise<{ storyMap: StoryMap; versions: StoryMapVersionMeta[] }> {
  const r = repo();
  const s = await r.loadSession();
  const normalized = normalizeStoryMap(map);
  pushVersion(s, "chat", reply, normalized);
  s.storyMap = normalized;
  s.messages = messages.slice(-MAX_MESSAGES);
  await r.saveSession(s);
  return { storyMap: s.storyMap, versions: s.versions.map(toMeta) };
}

// 会話履歴を消す(マップ・版はそのまま)。
export async function clearMessages(): Promise<void> {
  const r = repo();
  const s = await r.loadSession();
  s.messages = [];
  await r.saveSession(s);
}

// 版の一覧(メタ)。
export async function listVersions(): Promise<StoryMapVersionMeta[]> {
  return (await repo().loadSession()).versions.map(toMeta);
}

// 指定の版を現在のマップとして復元する。
// 復元は「過去の状態へ戻るナビゲーション」であり新しい変更ではないため、版は積まない
// (戻る前の状態はすでに版として残っているので失われない)。これで履歴が増殖しない。
export async function restoreVersion(
  id: string,
): Promise<{ storyMap: StoryMap; versions: StoryMapVersionMeta[] }> {
  const r = repo();
  const s = await r.loadSession();
  const target = s.versions.find((v) => v.id === id);
  if (!target) {
    throw new Error("指定のバージョンが見つかりません");
  }
  s.storyMap = target.storyMap;
  await r.saveSession(s);
  return { storyMap: s.storyMap, versions: s.versions.map(toMeta) };
}
