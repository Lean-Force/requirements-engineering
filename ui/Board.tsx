"use client";

import { Fragment, useRef, useState } from "react";
import type { ReleaseDef, StoryMap } from "@/domain";
import * as domain from "@/domain";
import type { RefineRequest, RefineResponse } from "@/contracts";
import CardEditModal from "./CardEditModal";

/** 📌 でチャットの対象に選ばれた付箋(ストーリーまたはタスク) */
export interface PickTarget {
  kind: "story" | "action";
  id: string;
  text: string;
}

interface Props {
  storyMap: StoryMap;
  onChange: (next: StoryMap) => void;
  /** 付箋の 📌 で「チャットの対象」に選ぶ(未指定ならボタン非表示) */
  onPickTarget?: (pick: PickTarget) => void;
  /** 付箋の AI 校正(未指定ならモーダルにボタンが出ない) */
  onRefine?: (req: RefineRequest) => Promise<RefineResponse | { error: string }>;
}

// インライン編集状態(ストーリー / タスク / アクターを単一の状態で扱う)。
type Editor =
  | { mode: "story-pick"; activityId: string } // どのアクターのタスクに足すか選択中
  | { mode: "story-add"; activityId: string; actionId: string } // 新規ストーリーを入力中
  | { mode: "story-edit"; activityId: string; actionId: string; storyId: string; initial: string; initialFixed: boolean }
  | { mode: "action-add"; activityId: string; actorId: string } // 空セルにタスクを入力中
  | { mode: "action-edit"; activityId: string; actionId: string; initial: string; initialFixed: boolean }
  | { mode: "actor-add" }; // 新規アクター名を入力中

// その場入力用の汎用フィールド。Enter 保存 / Esc 取消 / フォーカスを外すと保存。
// blur と keydown が二重に走らないよう done フラグで一度だけ確定する。
// multiline=true は textarea(Shift+Enter で改行)、false は input(1行)。
function InlineInput({
  multiline,
  className,
  color,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  multiline?: boolean;
  className: string;
  color?: { bg: string; border: string };
  initial: string;
  placeholder?: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onCommit(text);
    else onCancel();
  };
  const style = color ? { background: color.bg, borderColor: color.border } : undefined;
  const onKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => {
    if (e.key === "Enter" && (!multiline || !e.shiftKey)) {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  const common = {
    className,
    autoFocus: true,
    value: text,
    placeholder,
    style,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      setText(e.target.value),
    onKeyDown,
    onBlur: () => finish(true),
  };
  return multiline ? <textarea {...common} /> : <input {...common} />;
}

// アクターごとの色(付箋色)。
const ACTOR_COLORS = [
  { bg: "#f2c94c", border: "#d4ab2c" },
  { bg: "#fdf1ad", border: "#e6cf6a" },
  { bg: "#bfe3c0", border: "#8fce91" },
  { bg: "#bcd9f5", border: "#8cb8e6" },
  { bg: "#f6c9a8", border: "#e0a376" },
  { bg: "#e6c7f0", border: "#c79bd6" },
  { bg: "#f7b9c4", border: "#e08aa0" },
  { bg: "#c9e7e6", border: "#92c9c7" },
];

const COL_W = 140; // 列(ステップ)の幅。全列一定。ストーリーは縦積みなので横に広げない。

function noteFontSize(text: string): number {
  const n = [...text].length;
  if (n <= 10) return 13;
  if (n <= 18) return 12;
  if (n <= 30) return 11;
  if (n <= 48) return 10;
  return 9;
}

type Activity = StoryMap["activities"][number];

export default function Board({ storyMap, onChange, onPickTarget, onRefine }: Props) {
  const { actors, activities } = storyMap;

  // ストーリーの D&D 並び替え(同じ列 = ステップ内で上下自由。所属・色は変えない)。
  // dropHint はインジケータ表示用(対象カードの上半分 = 前に挿入 / 下半分 = 後ろに挿入)。
  const [draggingStory, setDraggingStory] = useState<{
    activityId: string;
    storyId: string;
  } | null>(null);
  const [dropHint, setDropHint] = useState<{ storyId: string; after: boolean } | null>(null);
  // ドラッグ直後の click で編集モーダルが開かないようにするガード
  const justDragged = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);

  // 随時(時系列外)のステップ。正規化で末尾へまとまるため、最初の随時列の前に区切りを描く
  const firstStandalone = activities.findIndex((a) => a.standalone === true);

  // アクティビティ(flowName)のバンド: 連続する同名のステップ群を 1 セグメントに。
  // 名前なしは単独セグメント、随時はまとめて 1 セグメント(名前なし)。
  type Segment = { key: string; name: string | null; ids: string[]; standalone: boolean };
  const segments: Segment[] = [];
  for (const a of activities) {
    const last = segments[segments.length - 1];
    if (a.standalone === true) {
      if (last?.standalone) last.ids.push(a.id);
      else segments.push({ key: a.id, name: null, ids: [a.id], standalone: true });
    } else if (a.flowName && last && !last.standalone && last.name === a.flowName) {
      last.ids.push(a.id);
    } else {
      segments.push({ key: a.id, name: a.flowName ?? null, ids: [a.id], standalone: false });
    }
  }
  // バンド名の編集状態(key = セグメント先頭のステップ id)
  const [flowEdit, setFlowEdit] = useState<{ key: string; value: string } | null>(null);
  const commitFlowName = (seg: Segment) => {
    if (!flowEdit) return;
    onChange(domain.setFlowName(storyMap, seg.ids, flowEdit.value));
    setFlowEdit(null);
  };
  const flowDivider = (activity: (typeof activities)[number], label = false) =>
    activity.standalone === true && activities[firstStandalone]?.id === activity.id ? (
      <div className="flow-divider" key={`div-${activity.id}`}>
        {label && <span className="flow-divider-label">随時・例外</span>}
      </div>
    ) : null;

  const toggleStandalone = (activityId: string, standalone: boolean) => {
    onChange(domain.setActivityStandalone(storyMap, activityId, standalone));
  };

  // リリース定義(既定 = MVP のみ)
  const releases: ReleaseDef[] =
    storyMap.releases && storyMap.releases.length > 0
      ? storyMap.releases
      : [{ name: "MVP" }];

  const changeRelease = (storyId: string, release: number) => {
    onChange(domain.setStoryRelease(storyMap, storyId, release));
  };

  const addRelease = () => {
    const next = [...releases, { name: `リリース${releases.length + 1}` }];
    onChange(domain.setReleases(storyMap, next));
  };

  const removeRelease = (index: number) => {
    if (releases.length <= 1) return;
    // 削除されたリリースのストーリーは未分類に戻す
    let map = storyMap;
    for (const act of map.activities)
      for (const a of act.actions)
        for (const st of a.stories)
          if (st.release === index) map = domain.setStoryRelease(map, st.id, -1);
          else if (typeof st.release === "number" && st.release > index)
            map = domain.setStoryRelease(map, st.id, st.release - 1);
    onChange(domain.setReleases(map, releases.filter((_, i) => i !== index)));
  };

  const renameRelease = (index: number, name: string) => {
    onChange(domain.setReleases(storyMap, releases.map((r, i) => i === index ? { name } : r)));
  };

  const colorOf = (actorId: string) => {
    const i = actors.findIndex((a) => a.id === actorId);
    return ACTOR_COLORS[(i < 0 ? 0 : i) % ACTOR_COLORS.length];
  };

  // ---- UI イベント → ドメイン操作 → 永続化 ----
  // index 省略=末尾、指定=途中に挿入。
  const addActivityAt = (index?: number) =>
    onChange(domain.addActivity(storyMap, index));

  const removeActivity = (activityId: string) => {
    if (window.confirm("このステップ(列)を削除しますか?配下のタスク・ストーリーも消えます。"))
      onChange(domain.removeActivity(storyMap, activityId));
  };

  // ---- アクター / タスク のインライン追加・編集 ----
  const commitAddActor = (name: string) => {
    setEditor(null);
    if (name.trim()) onChange(domain.addActor(storyMap, name.trim()));
  };

  const removeActor = (actorId: string) => {
    if (window.confirm("このアクター(行)を削除しますか?配下のタスク・ストーリーも消えます。"))
      onChange(domain.removeActor(storyMap, actorId));
  };

  // タスクの削除(配下にストーリーがあるときだけ確認)。
  const removeActionCard = (activityId: string, actionId: string, storyCount: number) => {
    if (storyCount === 0 || window.confirm("このタスクを削除しますか?配下のストーリーも消えます。"))
      onChange(domain.removeAction(storyMap, activityId, actionId));
  };

  // ストーリーの削除(末端なので確認なし)。
  const removeStoryCard = (activityId: string, actionId: string, storyId: string) =>
    onChange(domain.removeStory(storyMap, activityId, actionId, storyId));

  const commitAddAction = (activityId: string, actorId: string, text: string) => {
    setEditor(null);
    if (text.trim()) onChange(domain.addAction(storyMap, activityId, actorId, text.trim()));
  };

  const commitEditAction = (
    activityId: string,
    actionId: string,
    text: string,
    fixed: boolean,
  ) => {
    setEditor(null);
    if (!text.trim()) {
      // 空 = 削除(確定中はモーダル側で無効化されている)。配下ストーリーがあれば確認。
      const storyCount =
        domain.findAction(storyMap, activityId, actionId)?.stories.length ?? 0;
      if (
        storyCount === 0 ||
        window.confirm("このタスクを削除しますか?配下のストーリーも消えます。")
      ) {
        onChange(domain.removeAction(storyMap, activityId, actionId));
      }
      return;
    }
    onChange(
      domain.setActionFixed(
        domain.renameAction(storyMap, activityId, actionId, text.trim()),
        activityId,
        actionId,
        fixed,
      ),
    );
  };

  // ---- ストーリーのインライン追加・編集 ----
  const actorColorByAction = (activity: Activity, actionId: string) => {
    const a = activity.actions.find((x) => x.id === actionId);
    return colorOf(a ? a.actorId : (actors[0]?.id ?? ""));
  };

  // 「ストーリーを追加」起点。タスクが1つならそのまま入力へ、複数ならアクター選択へ。
  const startAddStory = (activity: Activity) => {
    if (activity.actions.length === 0) return;
    if (activity.actions.length === 1) {
      setEditor({ mode: "story-add", activityId: activity.id, actionId: activity.actions[0].id });
    } else {
      setEditor({ mode: "story-pick", activityId: activity.id });
    }
  };

  const commitAddStory = (activityId: string, actionId: string, text: string) => {
    setEditor(null);
    if (text.trim()) onChange(domain.addStory(storyMap, activityId, actionId, text.trim()));
  };

  const commitEditStory = (
    activityId: string,
    actionId: string,
    storyId: string,
    text: string,
    fixed: boolean,
  ) => {
    setEditor(null);
    if (!text.trim()) {
      // 空 = 削除(確定中はモーダル側で無効化されている)
      onChange(domain.removeStory(storyMap, activityId, actionId, storyId));
      return;
    }
    onChange(
      domain.setStoryFixed(
        domain.renameStory(storyMap, activityId, actionId, storyId, text.trim()),
        activityId,
        actionId,
        storyId,
        fixed,
      ),
    );
  };

  return (
    <div className="backbone">
      {actors.length === 0 && (
        <div className="board-empty">
          右のチャットで流れを伝えると、ここに反映されます。
        </div>
      )}

      {/* ===== activity line(アクター行 × ステップ列) ===== */}
      <div className="activity-line">
        {activities.length > 0 && segments.some((g) => !g.standalone) && (
          <div className="flow-bands">
            <div className="head-gutter"><span className="flow-bands-label">Activities</span></div>
            <div className="lane-flow">
              {segments.map((seg) => (
                <Fragment key={seg.key}>
                  {seg.standalone && <div className="flow-divider" />}
                  <div
                    className={`flow-band${seg.standalone ? " standalone" : ""}${seg.name ? "" : " unnamed"}`}
                    style={{ width: seg.ids.length * COL_W + (seg.ids.length - 1) * 12 }}
                  >
                    {seg.standalone ? (
                      <span className="flow-band-name muted">随時・例外</span>
                    ) : flowEdit?.key === seg.key ? (
                      <input
                        className="flow-band-input"
                        autoFocus
                        value={flowEdit.value}
                        onChange={(e) => setFlowEdit({ key: seg.key, value: e.target.value })}
                        onBlur={() => commitFlowName(seg)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitFlowName(seg);
                          if (e.key === "Escape") setFlowEdit(null);
                        }}
                      />
                    ) : (
                      <button
                        className="flow-band-name"
                        title={seg.name ? "このアクティビティの名前を変更" : "このステップ群にアクティビティの名前を付ける"}
                        onClick={() => setFlowEdit({ key: seg.key, value: seg.name ?? "" })}
                      >
                        {seg.name ?? "＋ アクティビティ名"}
                      </button>
                    )}
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        )}
        {activities.length > 0 && (
          <div className="activity-headers">
            <div className="head-gutter" />
            <div className="lane-flow">
              {activities.map((activity) => (
                    <Fragment key={activity.id}>
                      {flowDivider(activity, true)}
                      <div
                        className={`activity-head${activity.standalone ? " standalone" : ""}`}
                        style={{ width: COL_W }}
                      >
                        <button
                          className={`standalone-toggle${activity.standalone ? " on" : ""}`}
                          title={
                            activity.standalone
                              ? "随時(時系列外)のステップ。クリックで時系列の流れに戻す"
                              : "時系列の流れに属さないステップ(随時・例外)にする"
                          }
                          onClick={() => toggleStandalone(activity.id, !activity.standalone)}
                        >
                          {activity.standalone ? "随時" : "→随時"}
                        </button>
                        <button
                          className="del-activity"
                          title="このステップ(列)を削除"
                          onClick={() => removeActivity(activity.id)}
                        >
                          ×
                        </button>
                      </div>
                    </Fragment>
                  ))}
                </div>
              </div>
            )}

            {actors.map((actor) => {
              const color = colorOf(actor.id);
              return (
                <div className="lane" key={actor.id}>
                  <div
                    className="lane-label"
                    style={{ background: color.bg, borderColor: color.border }}
                  >
                    {actor.name}
                    <button
                      className="del-actor"
                      title="このアクター(行)を削除"
                      onClick={() => removeActor(actor.id)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="lane-flow">
                    {activities.map((activity, gi) => {
                      const action = domain.actionOf(activity, actor.id);
                      return (
                        <Fragment key={activity.id}>
                        {flowDivider(activity)}
                        <div
                          className={`step-cell activity-cell${activity.standalone ? " standalone" : ""}`}
                          style={{ width: COL_W }}
                        >
                          {/* 途中挿入(この列の前に。ホバーで表示) */}
                          <button
                            className="insert-activity"
                            title="ここにステップを挿入"
                            onClick={() => addActivityAt(gi)}
                          >
                            ＋
                          </button>

                          {action ? (
                            <div
                              className={`note clickable${action.fixed ? " fixed" : ""}`}
                              data-action-id={action.id}
                              data-activity-id={activity.id}
                              title={action.fixed ? `🔒 確定済み: ${action.text}` : action.text}
                              style={{ background: color.bg, borderColor: color.border }}
                              onClick={() =>
                                setEditor({
                                  mode: "action-edit",
                                  activityId: activity.id,
                                  actionId: action.id,
                                  initial: action.text,
                                  initialFixed: action.fixed === true,
                                })
                              }
                            >
                              <span style={{ fontSize: noteFontSize(action.text) }}>
                                {action.fixed && <span className="story-lock">🔒</span>}
                                {action.text}
                              </span>
                              {onPickTarget && (
                                <button
                                  className="pick-story"
                                  title="このタスクをチャットの対象にする"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPickTarget({ kind: "action", id: action.id, text: action.text });
                                  }}
                                >
                                  📌
                                </button>
                              )}
                              {!action.fixed && (
                                <button
                                  className="del-note"
                                  title="このタスクを削除"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeActionCard(activity.id, action.id, action.stories.length);
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          ) : editor?.mode === "action-add" &&
                            editor.activityId === activity.id &&
                            editor.actorId === actor.id ? (
                            <InlineInput
                              multiline
                              className="note-input"
                              color={color}
                              initial=""
                              placeholder="タスク(例: 商品を受け取る)"
                              onCommit={(t) => commitAddAction(activity.id, actor.id, t)}
                              onCancel={() => setEditor(null)}
                            />
                          ) : (
                            <button
                              className="cell-add"
                              title="タスクを追加"
                              onClick={() =>
                                setEditor({
                                  mode: "action-add",
                                  activityId: activity.id,
                                  actorId: actor.id,
                                })
                              }
                            >
                              ＋
                            </button>
                          )}
                        </div>
                        </Fragment>
                      );
                    })}

                    {/* 末尾にステップ追加(ホバーで表示) */}
                    <button
                      className="add-activity"
                      title="ステップを追加"
                      onClick={() => addActivityAt()}
                    >
                      ＋
                    </button>
                  </div>
                </div>
              );
            })}

            {/* アクター追加(全アクター共通・1つだけ) */}
            <div className="add-actor-row">
              {editor?.mode === "actor-add" ? (
                <InlineInput
                  className="actor-input"
                  initial=""
                  placeholder="アクター名(例: 管理者)"
                  onCommit={commitAddActor}
                  onCancel={() => setEditor(null)}
                />
              ) : (
                <button
                  className="add-actor-add"
                  title="アクターを追加"
                  onClick={() => setEditor({ mode: "actor-add" })}
                >
                  ＋ アクター
                </button>
              )}
            </div>
          </div>

      {/* ナラティブフロー(時系列) */}
      {activities.length > 0 && (
        <div className="narrative">
          <span className="narrative-text">ナラティブフロー(時系列)</span>
          <span className="narrative-line" />
          <span className="narrative-arrow">▶</span>
        </div>
      )}

      {/* ===== story line(リリースセクション × ステップ列) ===== */}
      {activities.length > 0 && (() => {
        // リリースセクション定義（末尾に「未分類」）
        type RelSection = { release: number | undefined; label: string };
        const relSections: RelSection[] = [
          ...releases.map((r, i) => ({ release: i as number | undefined, label: r.name })),
          { release: undefined, label: "未分類" },
        ];
        const showLines = true;

        // 各 activity のストーリーをリリースごとに事前分類
        const matchRel = (sr: number | undefined, sec: RelSection) =>
          sec.release === undefined
            ? sr === undefined || (typeof sr === "number" && sr < 0)
            : sr === sec.release;
        const perActivity = activities.map((activity) => {
          const all = domain.orderedStories(activity);
          const groups = relSections.map((sec) => all.filter((p) => matchRel(p.story.release, sec)));
          return { activity, all, groups };
        });

        return (
        <div className="story-line">
          <div className="lane">
            <div className="lane-label story-label">
              ストーリー
              <div className="release-controls">
                {releases.map((r, i) => (
                  <div key={i} className="release-tag" data-release={i}>
                    <input
                      className="release-name-input"
                      value={r.name}
                      onChange={(e) => renameRelease(i, e.target.value)}
                      title={`リリース ${i + 1} の名前を変更`}
                    />
                    {releases.length > 1 && (
                      <button
                        className="release-remove"
                        title="このリリースを削除"
                        onClick={() => removeRelease(i)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                <button className="release-add" onClick={addRelease} title="リリースを追加">
                  ＋ リリース
                </button>
              </div>
            </div>
            <div className="story-sections">
              {relSections.map((sec, si) => {
                const isLast = si === relSections.length - 1;
                return (
                <Fragment key={sec.release ?? "unassigned"}>
                  <div className="lane-flow">
                    {perActivity.map(({ activity, all, groups }) => {
                      const sectionStories = groups[si];
                      const sectionStart = groups.slice(0, si).reduce((sum, g) => sum + g.length, 0);
                      return (
                        <Fragment key={activity.id}>
                          {flowDivider(activity)}
                          <div
                            className={`step-cell story-col${activity.standalone ? " standalone" : ""}${
                              draggingStory?.activityId === activity.id ? " col-drop-zone" : ""
                            }`}
                            data-activity-id={activity.id}
                            style={{ width: COL_W }}
                            onDragOver={(e) => {
                              if (!draggingStory || draggingStory.activityId !== activity.id) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (!draggingStory || draggingStory.activityId !== activity.id) return;
                              let map = storyMap;
                              const dragged = all.find((x) => x.story.id === draggingStory.storyId);
                              if (dragged && dragged.story.release !== sec.release) {
                                map = domain.setStoryRelease(map, draggingStory.storyId, sec.release ?? -1);
                              }
                              onChange(domain.reorderStoryInColumn(map, activity.id, draggingStory.storyId, sectionStart + sectionStories.length));
                              setDraggingStory(null);
                              setDropHint(null);
                            }}
                          >
                            {sectionStories.map((pair, localIdx) => {
                              const { story: st, action } = pair;
                              const c = colorOf(action.actorId);
                              const displayIndex = sectionStart + localIdx;
                              return (
                                <div
                                  key={st.id}
                                  className={`story-card clickable${st.fixed ? " fixed" : ""}${
                                    draggingStory?.storyId === st.id ? " dragging" : ""
                                  }${
                                    dropHint?.storyId === st.id
                                      ? dropHint.after ? " drop-after" : " drop-before"
                                      : ""
                                  }`}
                                  data-action-id={action.id}
                                  data-release={st.release ?? -1}
                                  title={st.fixed ? `🔒 確定済み: ${st.text}` : st.text}
                                  style={{ background: c.bg, borderColor: c.border }}
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData("text/plain", st.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    setDraggingStory({ activityId: activity.id, storyId: st.id });
                                  }}
                                  onDragEnd={() => {
                                    setDraggingStory(null);
                                    setDropHint(null);
                                    justDragged.current = true;
                                    setTimeout(() => (justDragged.current = false), 150);
                                  }}
                                  onDragOver={(e) => {
                                    if (!draggingStory || draggingStory.storyId === st.id || draggingStory.activityId !== activity.id) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const after = e.clientY > rect.top + rect.height / 2;
                                    setDropHint((h) => h?.storyId === st.id && h.after === after ? h : { storyId: st.id, after });
                                  }}
                                  onDragLeave={() => setDropHint((h) => (h?.storyId === st.id ? null : h))}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    // 親(列)の onDrop = 「空き領域へのドロップは末尾へ」が
                                    // 二重に発火してこの並び替えを上書きしないようにする
                                    e.stopPropagation();
                                    if (!draggingStory || draggingStory.storyId === st.id || draggingStory.activityId !== activity.id) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const after = e.clientY > rect.top + rect.height / 2;
                                    let map = storyMap;
                                    const dragged = all.find((x) => x.story.id === draggingStory.storyId);
                                    if (dragged && dragged.story.release !== sec.release) {
                                      map = domain.setStoryRelease(map, draggingStory.storyId, sec.release ?? -1);
                                    }
                                    onChange(domain.reorderStoryInColumn(map, activity.id, draggingStory.storyId, displayIndex + (after ? 1 : 0)));
                                    setDraggingStory(null);
                                    setDropHint(null);
                                  }}
                                  onClick={() => {
                                    if (justDragged.current) return;
                                    setEditor({
                                      mode: "story-edit",
                                      activityId: activity.id,
                                      actionId: action.id,
                                      storyId: st.id,
                                      initial: st.text,
                                      initialFixed: st.fixed === true,
                                    });
                                  }}
                                >
                                  <span style={{ fontSize: noteFontSize(st.text) }}>
                                    {st.fixed && <span className="story-lock">🔒</span>}
                                    {st.text}
                                  </span>
                                  {onPickTarget && (
                                    <button className="pick-story" title="このストーリーをチャットの対象にする"
                                      onClick={(e) => { e.stopPropagation(); onPickTarget({ kind: "story", id: st.id, text: st.text }); }}>
                                      📌
                                    </button>
                                  )}
                                  {!st.fixed && (
                                    <button className="del-story" title="このストーリーを削除"
                                      onClick={(e) => { e.stopPropagation(); removeStoryCard(activity.id, action.id, st.id); }}>
                                      ×
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                  {showLines && !isLast && (
                    <div
                      className={`release-line-full${draggingStory ? " drop-zone" : ""}`}
                      onDragOver={(e) => {
                        if (!draggingStory) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!draggingStory) return;
                        const nextSec = relSections[si + 1];
                        if (!nextSec) return;
                        const pa = perActivity.find((p) => p.activity.id === draggingStory.activityId);
                        if (!pa) return;
                        let map = storyMap;
                        const dragged = pa.all.find((x) => x.story.id === draggingStory.storyId);
                        if (dragged && dragged.story.release !== nextSec.release) {
                          map = domain.setStoryRelease(map, draggingStory.storyId, nextSec.release ?? -1);
                        }
                        const nextStart = pa.groups.slice(0, si + 1).reduce((sum, g) => sum + g.length, 0);
                        onChange(domain.reorderStoryInColumn(map, draggingStory.activityId, draggingStory.storyId, nextStart));
                        setDraggingStory(null);
                        setDropHint(null);
                      }}
                    >
                      <span className="release-line-label">{sec.label}</span>
                    </div>
                  )}
                </Fragment>
              );
              })}
              {/* ストーリー追加行 */}
              <div className="lane-flow">
                {activities.map((activity) => (
                  <Fragment key={activity.id}>
                    {flowDivider(activity)}
                    <div
                      className="step-cell story-col"
                      data-activity-id={activity.id}
                      style={{ width: COL_W }}
                    >
                      {editor?.mode === "story-add" && editor.activityId === activity.id && (
                        <InlineInput
                          multiline
                          className="story-input"
                          color={actorColorByAction(activity, editor.actionId)}
                          initial=""
                          placeholder="ストーリー(例: 店員は…したい。なぜなら…)"
                          onCommit={(t) => commitAddStory(activity.id, editor.actionId, t)}
                          onCancel={() => setEditor(null)}
                        />
                      )}
                      {activity.actions.length > 0 &&
                        (editor?.mode === "story-pick" && editor.activityId === activity.id ? (
                          <div className="story-pick">
                            {activity.actions.map((action) => {
                              const c = colorOf(action.actorId);
                              const actor = actors.find((x) => x.id === action.actorId);
                              return (
                                <button
                                  key={action.id}
                                  className="story-chip"
                                  data-action-id={action.id}
                                  title={`${actor?.name ?? ""}「${action.text}」`}
                                  style={{ background: c.bg, borderColor: c.border }}
                                  onClick={() => setEditor({ mode: "story-add", activityId: activity.id, actionId: action.id })}
                                >
                                  {actor?.name ?? "?"}
                                </button>
                              );
                            })}
                            <button className="story-chip cancel" title="やめる" onClick={() => setEditor(null)}>×</button>
                          </div>
                        ) : (
                          <button className="story-slot-add" title="ストーリーを追加" onClick={() => startAddStory(activity)}>
                            ＋ ストーリーを追加
                          </button>
                        ))}
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
        );
      })()}

      {/* 付箋編集モーダル(body へポータル) */}
      {editor?.mode === "story-edit" && (
        <CardEditModal
          kind="story"
          key={editor.storyId}
          initial={editor.initial}
          initialFixed={editor.initialFixed}
          color={(() => {
            const activity = activities.find((a) => a.id === editor.activityId);
            return activity
              ? actorColorByAction(activity, editor.actionId)
              : ACTOR_COLORS[0];
          })()}
          onCommit={(t, fixed) =>
            commitEditStory(editor.activityId, editor.actionId, editor.storyId, t, fixed)
          }
          onCancel={() => setEditor(null)}
          onRefine={
            onRefine &&
            ((text) => {
              const activity = activities.find((a) => a.id === editor.activityId);
              const action = activity?.actions.find((x) => x.id === editor.actionId);
              const actor = actors.find((x) => x.id === action?.actorId);
              return onRefine({
                kind: "story",
                text,
                actorName: actor?.name,
                sceneActions: activity?.actions.map((x) => x.text),
                actionText: action?.text,
              });
            })
          }
        />
      )}
      {editor?.mode === "action-edit" && (
        <CardEditModal
          kind="action"
          key={editor.actionId}
          initial={editor.initial}
          initialFixed={editor.initialFixed}
          color={(() => {
            const activity = activities.find((a) => a.id === editor.activityId);
            return activity
              ? actorColorByAction(activity, editor.actionId)
              : ACTOR_COLORS[0];
          })()}
          onCommit={(t, fixed) =>
            commitEditAction(editor.activityId, editor.actionId, t, fixed)
          }
          onCancel={() => setEditor(null)}
          onRefine={
            onRefine &&
            ((text) => {
              const activity = activities.find((a) => a.id === editor.activityId);
              const action = activity?.actions.find((x) => x.id === editor.actionId);
              const actor = actors.find((x) => x.id === action?.actorId);
              return onRefine({
                kind: "action",
                text,
                actorName: actor?.name,
                sceneActions: activity?.actions.map((x) => x.text),
              });
            })
          }
        />
      )}
    </div>
  );
}
