"use client";

import { useRef, useState } from "react";
import type { StoryMap } from "@/domain";
import * as domain from "@/domain";

interface Props {
  storyMap: StoryMap;
  onChange: (next: StoryMap) => void;
}

// インライン編集状態(ストーリー / 行動 / アクターを単一の状態で扱う)。
type Editor =
  | { mode: "story-pick"; activityId: string } // どのアクターの行動に足すか選択中
  | { mode: "story-add"; activityId: string; actionId: string } // 新規ストーリーを入力中
  | { mode: "story-edit"; activityId: string; actionId: string; storyId: string; initial: string }
  | { mode: "action-add"; activityId: string; actorId: string } // 空セルに行動を入力中
  | { mode: "action-edit"; activityId: string; actionId: string; initial: string }
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

const COL_W = 140; // 列(アクティビティ)の幅。全列一定。ストーリーは縦積みなので横に広げない。

function noteFontSize(text: string): number {
  const n = [...text].length;
  if (n <= 10) return 13;
  if (n <= 18) return 12;
  if (n <= 30) return 11;
  if (n <= 48) return 10;
  return 9;
}

type Activity = StoryMap["activities"][number];

export default function Board({ storyMap, onChange }: Props) {
  const { actors, activities } = storyMap;
  const [editor, setEditor] = useState<Editor | null>(null);

  const colorOf = (actorId: string) => {
    const i = actors.findIndex((a) => a.id === actorId);
    return ACTOR_COLORS[(i < 0 ? 0 : i) % ACTOR_COLORS.length];
  };

  // ---- UI イベント → ドメイン操作 → 永続化 ----
  // index 省略=末尾、指定=途中に挿入。
  const addActivityAt = (index?: number) =>
    onChange(domain.addActivity(storyMap, index));

  const removeActivity = (activityId: string) => {
    if (window.confirm("この場面(列)を削除しますか?配下の行動・ストーリーも消えます。"))
      onChange(domain.removeActivity(storyMap, activityId));
  };

  // ---- アクター / 行動 のインライン追加・編集 ----
  const commitAddActor = (name: string) => {
    setEditor(null);
    if (name.trim()) onChange(domain.addActor(storyMap, name.trim()));
  };

  const commitAddAction = (activityId: string, actorId: string, text: string) => {
    setEditor(null);
    if (text.trim()) onChange(domain.addAction(storyMap, activityId, actorId, text.trim()));
  };

  const commitEditAction = (activityId: string, actionId: string, text: string) => {
    setEditor(null);
    onChange(
      text.trim()
        ? domain.renameAction(storyMap, activityId, actionId, text.trim())
        : domain.removeAction(storyMap, activityId, actionId),
    );
  };

  // ---- ストーリーのインライン追加・編集 ----
  const actorColorByAction = (activity: Activity, actionId: string) => {
    const a = activity.actions.find((x) => x.id === actionId);
    return colorOf(a ? a.actorId : (actors[0]?.id ?? ""));
  };

  // 「ストーリーを追加」起点。行動が1つならそのまま入力へ、複数ならアクター選択へ。
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
  ) => {
    setEditor(null);
    onChange(
      text.trim()
        ? domain.renameStory(storyMap, activityId, actionId, storyId, text.trim())
        : domain.removeStory(storyMap, activityId, actionId, storyId),
    );
  };

  return (
    <div className="backbone">
      {actors.length === 0 && (
        <div className="board-empty">
          右のチャットで流れを伝えると、ここに反映されます。
        </div>
      )}

      {/* ===== activity line(アクター行 × アクティビティ列) ===== */}
      <div className="activity-line">
        {activities.length > 0 && (
          <div className="activity-headers">
            <div className="head-gutter" />
            <div className="lane-flow">
              {activities.map((activity) => (
                    <div className="activity-head" key={activity.id} style={{ width: COL_W }}>
                      <button
                        className="del-activity"
                        title="この場面(列)を削除"
                        onClick={() => removeActivity(activity.id)}
                      >
                        ×
                      </button>
                    </div>
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
                  </div>
                  <div className="lane-flow">
                    {activities.map((activity, gi) => {
                      const action = domain.actionOf(activity, actor.id);
                      return (
                        <div
                          className="step-cell activity-cell"
                          key={activity.id}
                          style={{ width: COL_W }}
                        >
                          {/* 途中挿入(この列の前に。ホバーで表示) */}
                          <button
                            className="insert-activity"
                            title="ここにアクティビティを挿入"
                            onClick={() => addActivityAt(gi)}
                          >
                            ＋
                          </button>

                          {editor?.mode === "action-edit" &&
                          action &&
                          editor.actionId === action.id ? (
                            <InlineInput
                              multiline
                              className="note-input"
                              color={color}
                              initial={editor.initial}
                              placeholder="行動(空にすると削除)"
                              onCommit={(t) => commitEditAction(activity.id, action.id, t)}
                              onCancel={() => setEditor(null)}
                            />
                          ) : action ? (
                            <div
                              className="note clickable"
                              data-action-id={action.id}
                              data-activity-id={activity.id}
                              title={action.text}
                              style={{ background: color.bg, borderColor: color.border }}
                              onClick={() =>
                                setEditor({
                                  mode: "action-edit",
                                  activityId: activity.id,
                                  actionId: action.id,
                                  initial: action.text,
                                })
                              }
                            >
                              <span style={{ fontSize: noteFontSize(action.text) }}>
                                {action.text}
                              </span>
                            </div>
                          ) : editor?.mode === "action-add" &&
                            editor.activityId === activity.id &&
                            editor.actorId === actor.id ? (
                            <InlineInput
                              multiline
                              className="note-input"
                              color={color}
                              initial=""
                              placeholder="行動(例: 商品を受け取る)"
                              onCommit={(t) => commitAddAction(activity.id, actor.id, t)}
                              onCancel={() => setEditor(null)}
                            />
                          ) : (
                            <button
                              className="cell-add"
                              title="行動を追加"
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
                      );
                    })}

                    {/* 末尾にアクティビティ追加(ホバーで表示) */}
                    <button
                      className="add-activity"
                      title="アクティビティを追加"
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

      {/* ===== story line(各アクティビティ列の下に、各アクターのストーリーを色分けで) ===== */}
      {activities.length > 0 && (
        <div className="story-line">
          <div className="lane">
            <div className="lane-label story-label">ストーリー</div>
            <div className="lane-flow">
              {activities.map((activity) => (
                    <div
                      className="step-cell story-col"
                      data-activity-id={activity.id}
                      key={activity.id}
                      style={{ width: COL_W }}
                    >
                      {/* 上: ストーリーカードを列の先頭から詰めて縦積み。編集中は textarea に差し替え */}
                      {activity.actions.map((action) => {
                        const c = colorOf(action.actorId);
                        return action.stories.map((st) =>
                          editor?.mode === "story-edit" && editor.storyId === st.id ? (
                            <InlineInput
                              multiline
                              key={st.id}
                              className="story-input"
                              color={c}
                              initial={editor.initial}
                              placeholder="ストーリー(空にすると削除)"
                              onCommit={(t) => commitEditStory(activity.id, action.id, st.id, t)}
                              onCancel={() => setEditor(null)}
                            />
                          ) : (
                            <div
                              key={st.id}
                              className="story-card clickable"
                              data-action-id={action.id}
                              title={st.text}
                              style={{ background: c.bg, borderColor: c.border }}
                              onClick={() =>
                                setEditor({
                                  mode: "story-edit",
                                  activityId: activity.id,
                                  actionId: action.id,
                                  storyId: st.id,
                                  initial: st.text,
                                })
                              }
                            >
                              <span style={{ fontSize: noteFontSize(st.text) }}>
                                {st.text}
                              </span>
                            </div>
                          ),
                        );
                      })}

                      {/* 追加中の新カード(その場入力) */}
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

                      {/* 下: アクター選択チップ(複数アクション時)or「ストーリーを追加」 */}
                      {activity.actions.length > 0 &&
                        (editor?.mode === "story-pick" &&
                        editor.activityId === activity.id ? (
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
                                  onClick={() =>
                                    setEditor({
                                      mode: "story-add",
                                      activityId: activity.id,
                                      actionId: action.id,
                                    })
                                  }
                                >
                                  {actor?.name ?? "?"}
                                </button>
                              );
                            })}
                            <button
                              className="story-chip cancel"
                              title="やめる"
                              onClick={() => setEditor(null)}
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <button
                            className="story-slot-add"
                            title="ストーリーを追加"
                            onClick={() => startAddStory(activity)}
                          >
                            ＋ ストーリーを追加
                          </button>
                        ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
