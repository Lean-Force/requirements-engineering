// システムテスト: モック・フェイクを一切使わず、実 LLM で全配線を通す。
//
//   npm run test:system
//
// eval(L4)がゲートウェイ関数を直接呼ぶのに対し、ここは API ルートハンドラから
// ユースケース → 実 LLM → ドメイン → 永続化まで本物だけで 1 シナリオを流す。
// 判定は eval と同じく「事実の包含」に寄せる(文言一致を避ける)。
// 実行時間 5 分前後・$2 前後。リリース前・大きな配線変更時に回す。

import { promises as fs } from "fs";
import os from "os";
import path from "path";

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "usm-system-"));

const { POST: boardsPost } = await import("../../app/api/boards/route");
const { PUT: storymapPut } = await import("../../app/api/boards/[boardId]/storymap/route");
const { POST: chatPost } = await import("../../app/api/boards/[boardId]/chat/route");
const { GET: contextsGet, POST: contextsPost } = await import(
  "../../app/api/boards/[boardId]/contexts/route"
);
const { DELETE: conflictDelete } = await import(
  "../../app/api/boards/[boardId]/contexts/conflicts/[conflictId]/route"
);
const { POST: proposalAccept } = await import(
  "../../app/api/boards/[boardId]/contexts/proposals/[proposalId]/accept/route"
);
const { POST: refinePost } = await import("../../app/api/boards/[boardId]/refine/route");
const { GET: knowledgeGet } = await import("../../app/api/knowledge/route");

type Json = Record<string, any>;
const json = (method: string, body?: unknown) =>
  new Request("http://system.test/api", method === "GET" ? { method } : {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const upload = (fileName: string, content: string) => {
  const form = new FormData();
  form.append("files", new File([content], fileName, { type: "text/plain" }));
  return new Request("http://system.test/api", { method: "POST", body: form });
};

let failed = 0;
let stepStarted = Date.now();
function check(name: string, problems: string[]) {
  const secs = Math.round((Date.now() - stepStarted) / 1000);
  if (problems.length === 0) {
    console.log(`✅ PASS (${secs}s) ${name}`);
  } else {
    failed++;
    console.log(`❌ FAIL (${secs}s) ${name}`);
    for (const p of problems) console.log(`   - ${p}`);
  }
  stepStarted = Date.now();
}

// ---- シナリオ ---------------------------------------------------------------

// 1. ボード作成
const board: Json = await (await boardsPost(json("POST", { name: "送金処理" }))).json();
const P = { params: { boardId: board.id } };
check("ボード作成(ルート)", board.id ? [] : ["ボードが作成されない"]);

// 2. 資料の取り込み(実抽出 + スコープ自動振り分け + 矛盾/新業務スキャン)
const DOC = `# 送金業務 設計メモ

## 全社用語
- BSAD: 基本設計書の社内略称(全社共通)。

## 業務ルール
- 1,000万円を超える送金は部長承認が必要。

## データ定義
- 送金種別: 01:即時 / 02:予約。`;
{
  const res = await contextsPost(upload("送金設計.txt", DOC), P);
  const state: Json = await res.json();
  const problems: string[] = [];
  if (res.status !== 200) problems.push(`取り込みが ${res.status}(${state.error ?? ""})`);
  else {
    if (state.sources.length !== 1) problems.push("資料が 1 件にならない");
    const count = (c: string) => state.categories.find((x: Json) => x.category === c)?.count ?? 0;
    if (count("flows") < 1) problems.push("承認ルール(flows)が抽出されていない");
    if (count("terms") < 1) problems.push("用語(terms)が抽出されていない");
    if (state.contextSize.tokens <= 0) problems.push("contextSize が計測されていない");
    // 用語は方針で常に共通 → /knowledge の集約に現れる
    const admin: Json = await (await knowledgeGet()).json();
    if ((admin.categories.find((x: Json) => x.category === "terms")?.count ?? 0) < 1)
      problems.push("BSAD が共通知識(/knowledge)に集約されていない");
  }
  check("取り込み → 実抽出 → 自動振り分け → 共通集約", problems);
}

// 3. チャット(実 LLM): 知識を根拠に承認の場面を追加
let mapAfterChat: Json = { actors: [], activities: [] };
{
  const res = await chatPost(
    json("POST", {
      messages: [
        { role: "user", content: "承認のルールに従って、承認の場面をマップに追加して。金額の閾値も本文に明記して。" },
      ],
      storyMap: { actors: [], activities: [] },
    }),
    P,
  );
  const body: Json = await res.json();
  const problems: string[] = [];
  if (res.status !== 200) problems.push(`チャットが ${res.status}(${body.error ?? ""})`);
  else {
    mapAfterChat = body.storyMap;
    const mapJson = JSON.stringify(body.storyMap);
    if (!mapJson.includes("1,000万") && !mapJson.includes("1000万"))
      problems.push("閾値(1,000万)がマップに反映されていない");
    if (!mapJson.includes("部長")) problems.push("承認者(部長)がマップに反映されていない");
    if (!body.versions?.some((v: Json) => v.source === "chat"))
      problems.push("chat の版が積まれていない");
  }
  check("チャット: 知識を根拠にマップへ反映", problems);
}

// 4. 確定保護: ストーリーを確定し、実 LLM に変更を依頼しても壊れない
{
  // 閾値を含むストーリー(無ければ最初のストーリー)を確定する
  outer: for (const act of mapAfterChat.activities)
    for (const a of act.actions)
      for (const s of a.stories) {
        if (JSON.stringify(s.text).includes("1,000万") || true) {
          s.fixed = true;
          a.fixed = true;
          break outer;
        }
      }
  await storymapPut(json("PUT", mapAfterChat), P);
  const fixedStory = mapAfterChat.activities
    .flatMap((x: Json) => x.actions)
    .flatMap((x: Json) => x.stories)
    .find((s: Json) => s.fixed);

  const res = await chatPost(
    json("POST", {
      messages: [
        { role: "user", content: "確定済みのストーリーの本文を「まったく別の内容」に書き換えて。" },
      ],
      storyMap: mapAfterChat,
    }),
    P,
  );
  const body: Json = await res.json();
  const problems: string[] = [];
  if (res.status !== 200) problems.push(`チャットが ${res.status}`);
  else {
    const after = body.storyMap.activities
      .flatMap((x: Json) => x.actions)
      .flatMap((x: Json) => x.stories)
      .find((s: Json) => s.id === fixedStory.id);
    if (!after) problems.push("確定ストーリーが消えた");
    else if (after.text !== fixedStory.text) problems.push("確定ストーリーの本文が変わった");
    else if (after.fixed !== true) problems.push("fixed フラグが剥がれた");
  }
  check("確定保護: 実 LLM の変更依頼でも本文・fixed が守られる", problems);
}

// 5. 付箋の AI 校正(実 LLM)
{
  // 実 UI と同じく、付箋が属する場面の文脈(行動・同じ場面の行動)を渡す
  const res = await refinePost(
    json("POST", {
      kind: "story",
      text: "レシートほしい",
      actorName: "店員",
      actionText: "会計する",
      sceneActions: ["会計する"],
    }),
    P,
  );
  const body: Json = await res.json();
  const problems: string[] = [];
  if (res.status !== 200) problems.push(`校正が ${res.status}(${body.error ?? ""})`);
  else {
    if (!body.suggestion?.includes("したい") && !body.suggestion?.includes("ほしい"))
      problems.push(`推奨形式(欲求の一人称)になっていない: ${body.suggestion}`);
    if (!body.suggestion?.includes("なぜなら"))
      problems.push(`理由(なぜなら)が補われていない: ${body.suggestion}`);
  }
  check("付箋の AI 校正: 推奨形式へ推敲", problems);
}

// 6. 矛盾検出(実 LLM): 改定規程を取り込むと食い違いが検出される
{
  const res = await contextsPost(
    upload("新規程.txt", "# 規程改定\n\n- 送金の承認: 2億円を超える送金は役員承認が必要(改定)。"),
    P,
  );
  const state: Json = await res.json();
  const problems: string[] = [];
  if (res.status !== 200) problems.push(`取り込みが ${res.status}`);
  else {
    const hit = state.conflicts.find(
      (c: Json) => `${c.newClaim}${c.existingClaim}${c.topic}`.includes("承認"),
    );
    if (!hit) problems.push(`承認閾値の矛盾が検出されていない(conflicts: ${state.conflicts.length} 件)`);
    else {
      const cleared: Json = await (
        await conflictDelete(json("DELETE"), { params: { boardId: board.id, conflictId: hit.id } })
      ).json();
      if (cleared.conflicts.some((c: Json) => c.id === hit.id)) problems.push("解決済みにできない");
    }
  }
  check("矛盾検出: 改定規程との食い違いを検出 → 解決", problems);
}

// 7. 新業務の検知(実 LLM)→ 承認でボード作成 + 資料移動
{
  const res = await contextsPost(
    upload(
      "口座開設フロー.txt",
      "# 口座開設業務\n\n- 口座開設の審査: 本人確認書類の確認 → 反社チェック → 開設可否の判定。\n- 必要書類: 本人確認書類、印鑑届。",
    ),
    P,
  );
  const state: Json = await res.json();
  const problems: string[] = [];
  if (res.status !== 200) problems.push(`取り込みが ${res.status}`);
  else {
    const proposal = state.proposals.find((p: Json) => p.name.includes("口座"));
    if (!proposal)
      problems.push(`新業務(口座開設)が提案されていない(proposals: ${JSON.stringify(state.proposals.map((p: Json) => p.name))})`);
    else {
      const accepted: Json = await (
        await proposalAccept(json("POST"), { params: { boardId: board.id, proposalId: proposal.id } })
      ).json();
      if (!accepted.board?.id) problems.push("承認でボードが作られない");
      else {
        const moved: Json = await (
          await contextsGet(json("GET"), { params: { boardId: accepted.board.id } })
        ).json();
        if (!moved.sources.some((s: Json) => s.fileName === "口座開設フロー.txt"))
          problems.push("資料が新ボードへ移動していない");
      }
    }
  }
  check("新業務の検知 → 承認でボード作成 + 資料移動", problems);
}

await fs.rm(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${7 - failed}/7 passed`);
process.exit(failed > 0 ? 1 : 0);
