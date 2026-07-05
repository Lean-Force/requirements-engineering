// レベル3: AI が知識を「正しく使うか」の eval(実 LLM を呼ぶ)。
//
//   npm run eval
//
// CI 常時ではなく、リリース前・プロンプト変更時に手動で回す想定
// (1ケース $0.1〜0.3 / 全体で数分)。知識のシードは LLM を使わず
// エントリを直接書き込むため、テスト対象は「AI が知識を読む・使う」部分だけ。
//
// 判定は決定的に寄せる:
//   - usedSkills(generate が記録する「実際に Read された skill」)への包含/除外
//   - structured output(マップ JSON)への事実の包含/除外
//   - reply への包含
// LLM のゆれで際どいケースは、期待を「事実の存在」に留めて文言一致を避ける。

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { detectConflicts, detectNewBusiness, extractKnowledge, extractKnowledgeMulti, generate } from "../../infrastructure/agent";
import {
  knowledgeFile,
  sourcesFile,
  writeJson,
} from "../../infrastructure/context/repository";
import { renderCommonSkills, renderSkills, prepareSkillsForChat } from "../../infrastructure/context/skills";
import { saveStoryMap } from "../../infrastructure/storage";
import { writeJson } from "../../infrastructure/context/repository";
import { COMMON_SCOPE } from "../../infrastructure/context/workspace";
import type { KnowledgeCategory } from "../../contracts";

// ---- シード(LLM を使わずエントリを直接書き込む) ---------------------------

interface SeedEntry {
  category: KnowledgeCategory;
  title: string;
  content: string;
}

let seq = 0;
async function seed(
  scope: string,
  fileName: string,
  entries: SeedEntry[],
  enabled = true,
): Promise<void> {
  const sourceId = `eval-src-${++seq}`;
  const sources = [
    {
      id: sourceId,
      fileName,
      enabled,
      entryCount: entries.length,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  // スコープはエントリ単位: 共通スコープへのシードは common エントリになる
  const knowledge = entries.map((e, i) => ({
    id: `eval-ent-${seq}-${i}`,
    sourceId,
    common: scope === COMMON_SCOPE,
    ...e,
  }));
  await writeJson(sourcesFile(scope), sources);
  await writeJson(knowledgeFile(scope), knowledge);
  if (scope === COMMON_SCOPE) await renderCommonSkills();
  else await renderSkills(scope);
}

// ---- ケース定義 -------------------------------------------------------------

interface EvalCase {
  name: string;
  boardId: string;
  message: string;
  /** 会話に添付する現在のマップ(省略時は空マップ) */
  map?: unknown;
  usedMustInclude?: string[];
  usedMustBeEmpty?: boolean;
  mapMustInclude?: string[];
  mapMustExclude?: string[];
  replyMustInclude?: string[];
}

const CASES: EvalCase[] = [
  {
    name: "読むべき時に読む + 正確に反映 + 矛盾は業務優先",
    boardId: "eval-soukin",
    message:
      "承認のルールに従って、承認の場面をマップに追加して。金額の閾値も本文に明記して。",
    usedMustInclude: ["kb-flows"],
    mapMustInclude: ["部長", "1,000万"],
    mapMustExclude: ["500万"], // 共通規程(500万)ではなく業務の知識(1,000万)を採る
  },
  {
    name: "読まなくていい時に読まない(機械的な操作)",
    boardId: "eval-soukin",
    message:
      "アクター「テスト太郎」を1人追加して。それ以外は何も変えないで。知識の参照も不要です。",
    usedMustBeEmpty: true,
    mapMustInclude: ["テスト太郎"],
  },
  {
    name: "業務間の分離(他業務の知識は存在しない)",
    boardId: "eval-koza",
    message:
      "この業務の知識に「送金の部長承認ルール」があればマップに追加して。無ければマップは変えず、reply で無い旨を答えて。",
    mapMustExclude: ["1,000万"],
  },
  {
    name: "off にした資料の知識は使われない",
    boardId: "eval-off",
    message:
      "承認のルールに従って、承認の場面をマップに追加して。金額の閾値が知識にあれば本文に明記して。",
    mapMustExclude: ["1,000万"],
  },
  {
    name: "データ定義の正確な反映(値域)",
    boardId: "eval-soukin",
    message: "送金種別の選択肢を、それぞれストーリーとして明記して追加して。",
    usedMustInclude: ["kb-data"],
    mapMustInclude: ["即時", "予約"],
  },
  {
    name: "共通知識(用語集)を読んで答える",
    boardId: "eval-koza",
    message: "BSAD という言葉の意味を reply で説明して。マップは変えないで。",
    usedMustInclude: ["kb-common-terms"],
    replyMustInclude: ["基本設計書"],
  },
  {
    name: "確定(fixed)要素の変更依頼は拒み、確定解除を案内する",
    boardId: "eval-soukin",
    map: {
      actors: [{ id: "actor-op", name: "オペレーター" }],
      activities: [
        {
          id: "act-1",
          actions: [
            {
              id: "action-1",
              actorId: "actor-op",
              text: "承認を得る",
              fixed: true,
              stories: [
                {
                  id: "story-1",
                  text: "オペレーターは3億円を超える送金で役員承認を得たい。なぜなら規程で役員決裁が必須だからだ。",
                  fixed: true,
                },
              ],
            },
          ],
        },
      ],
    },
    message: "「3億円」のストーリーの金額を1億円に変更して。",
    mapMustInclude: ["3億円"],
    mapMustExclude: ["1億円"],
    replyMustInclude: ["確定"],
  },
  {
    name: "他業務の合意済みマップ(kb-common-maps)を参照して答える",
    boardId: "eval-koza",
    message:
      "「送金処理」の業務で確定(チーム合意)済みになっている承認まわりの決定があれば、reply で教えて。マップは変えないで。",
    usedMustInclude: ["kb-common-maps"],
    replyMustInclude: ["役員"],
  },
];

// ---- 実行 -------------------------------------------------------------------

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-eval-"));
  process.env.DATA_DIR = tmp;

  // 送金業務: 承認ルール(1,000万)+ 送金種別(01/02)
  await seed("eval-soukin", "送金設計.xlsx", [
    { category: "flows", title: "送金の承認ルール", content: "1,000万円を超える送金は部長承認が必要。" },
    { category: "data", title: "送金種別", content: "送金種別の値域: 01:即時 / 02:予約 の2種類。" },
  ]);
  // 口座開設業務: 独自ルールのみ(送金の知識は存在しない)
  await seed("eval-koza", "口座審査.xlsx", [
    { category: "flows", title: "口座開設の審査", content: "反社チェック NG は即否決。" },
  ]);
  // off 検証用: 承認ルールはあるが資料が無効
  await seed("eval-off", "送金設計.xlsx", [
    { category: "flows", title: "送金の承認ルール", content: "1,000万円を超える送金は部長承認が必要。" },
  ], false);
  // 共通知識: 業務と矛盾する承認規程 + 用語集
  await seed(COMMON_SCOPE, "全社規程.xlsx", [
    { category: "flows", title: "承認の全社標準", content: "500万円を超える取引は部長承認が必要(全社標準)。" },
    { category: "terms", title: "BSAD", content: "BSAD は基本設計書の社内略称。" },
  ]);

  // 送金業務の「確定済みマップ」(kb-common-maps 経由で他業務から見える)。
  // 知識シード(1,000万/部長)とは別の事実(3億/役員)にして、マップ由来と判別できるようにする
  await writeJson(path.join(tmp, "boards.json"), [
    { id: "eval-soukin", name: "送金処理", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "eval-koza", name: "口座開設", createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  await saveStoryMap("eval-soukin", {
    actors: [{ id: "actor-op", name: "オペレーター" }],
    activities: [
      {
        id: "act-approve",
        actions: [
          {
            id: "action-approve",
            actorId: "actor-op",
            text: "承認を得る",
            fixed: true,
            stories: [
              {
                id: "story-approve",
                text: "オペレーターは3億円を超える送金で役員承認を得たい。なぜなら規程で役員決裁が必須だからだ。",
                fixed: true,
              },
            ],
          },
        ],
      },
    ],
  });

  let failed = 0;

  // ---- 抽出: 観点別 5 パスの再現率(vs 1 パス)+ common 自動判定 --------------
  {
    const started = Date.now();
    // 5 カテゴリの事実を仕込んだフィクスチャ資料(既知の正解 = FACTS)
    const FIXTURE = `# 送金業務 基本設計書(抜粋)

## 全社用語
- BSAD: 基本設計書の社内略称(全社共通)。
- 送金指示番号: 英数字12桁で採番する。

## 関係者
- 為替ディーラー: 適用レートの確定を担当する。
- オペレーター: 送金データの入力と一次チェックを行う。

## 業務ルール
- 1,000万円を超える送金は部長承認が必要。
- カットオフは 15:00。以降の受付は翌営業日扱いとする。
- 形式不備は営業店へ差し戻しする。

## データ定義
- 送金種別: 01:即時 / 02:予約。
- 手数料区分: SHA / OUR / BEN のいずれか。
- 送金金額の上限は 1億円。

## 背景
- 月末に処理が滞留しており、手作業チェックの負荷が高い。`;

    // 各事実の「見つかった」判定キーワード(タイトル+本文への包含)
    const FACTS = [
      "BSAD", "英数字12桁", "為替ディーラー", "オペレーター",
      "1,000万", "15:00", "差し戻し", "予約", "SHA", "1億", "滞留",
    ];
    const recallOf = (entries: { title: string; content: string }[]) => {
      const all = entries.map((e) => e.title + e.content).join("\n");
      return FACTS.filter((f) => all.includes(f));
    };

    const [single, multi] = await Promise.all([
      extractKnowledge("基本設計書.md", FIXTURE),
      extractKnowledgeMulti("基本設計書.md", FIXTURE),
    ]);
    const singleHits = recallOf(single);
    const multiHits = recallOf(multi);
    console.log(
      `   再現率: 1パス ${singleHits.length}/${FACTS.length}(${single.length}エントリ) / ` +
      `5パス ${multiHits.length}/${FACTS.length}(${multi.length}エントリ)`,
    );

    const problems: string[] = [];
    const missed = FACTS.filter((f) => !multiHits.includes(f));
    if (multiHits.length < singleHits.length)
      problems.push(`5パスの再現率が1パスを下回った(取りこぼし: ${missed.join(", ")})`);
    if (multiHits.length < FACTS.length - 1)
      problems.push(`5パスの取りこぼしが多い: ${missed.join(", ")}`);
    // common 自動判定(5 パス側 = 本番経路で確認)
    const find = (kw: string) => multi.find((e) => (e.title + e.content).includes(kw));
    const bsad = find("BSAD");
    const rule = find("1,000万");
    if (bsad && bsad.common !== true) problems.push("全社用語 BSAD が共通(common=true)になっていない");
    if (rule && rule.common !== false) problems.push("業務の承認ルールが業務固有(common=false)になっていない");

    const secs = Math.round((Date.now() - started) / 1000);
    if (problems.length === 0) {
      console.log(`✅ PASS (${secs}s) 観点別5パス抽出の再現率と common 判定`);
    } else {
      failed++;
      console.log(`❌ FAIL (${secs}s) 観点別5パス抽出の再現率と common 判定`);
      for (const pr of problems) console.log(`   - ${pr}`);
    }
  }

  // ---- 矛盾検出: 実質的な食い違いだけを拾う(補完関係は拾わない) ---------------
  {
    const started = Date.now();
    const conflicts = await detectConflicts(
      "新規程.xlsx",
      [
        "送金の承認ルール: 2億円を超える送金は役員承認が必要。",
        "手数料区分: SHA / OUR / BEN のいずれか。",
      ].join("\n"),
      [
        "[出典: 旧規程.xlsx] 送金の承認ルール: 1,000万円を超える送金は部長承認が必要。",
        "[出典: 用語集.xlsx] BSAD: 基本設計書の社内略称。",
      ].join("\n"),
    );
    const problems: string[] = [];
    const hit = conflicts.find((c) => c.existingSource.includes("旧規程"));
    if (!hit) problems.push("承認閾値の矛盾(旧規程)が検出されていない");
    else if (!`${hit.newClaim}${hit.existingClaim}`.includes("役員") )
      problems.push("矛盾の主張に具体的な内容(役員承認)が含まれていない");
    if (conflicts.some((c) => c.existingSource.includes("用語集")))
      problems.push("無関係な用語集との誤検出(false positive)がある");
    const secs = Math.round((Date.now() - started) / 1000);
    if (problems.length === 0) {
      console.log(`✅ PASS (${secs}s) 矛盾検出: 実質的な食い違いのみを拾う`);
    } else {
      failed++;
      console.log(`❌ FAIL (${secs}s) 矛盾検出: 実質的な食い違いのみを拾う`);
      for (const pr of problems) console.log(`   - ${pr}`);
      console.log(`   conflicts: ${JSON.stringify(conflicts)}`);
    }
  }

  // ---- 新業務の検知: 別業務は提案し、既存業務の補足は提案しない ----------------
  {
    const started = Date.now();
    const [newBiz, sameBiz] = await Promise.all([
      detectNewBusiness(
        "口座開設フロー.xlsx",
        [
          "口座開設の審査: 本人確認書類の確認 → 反社チェック → 開設可否の判定。",
          "口座開設の必要書類: 本人確認書類、印鑑届、マイナンバー確認書類。",
        ].join("\n"),
        ["送金処理"],
        "共通知識の管理画面(特定の業務に紐づかない)",
      ),
      detectNewBusiness(
        "送金補足.xlsx",
        "送金の承認ルール補足: 1,000万円超は部長承認。休日受付は翌営業日扱い。",
        ["送金処理"],
        "業務「送金処理」のボード",
      ),
    ]);
    const problems: string[] = [];
    if (!newBiz.isNewBusiness) problems.push("別業務(口座開設)の資料が新業務と判定されていない");
    else if (!newBiz.name.includes("口座")) problems.push(`業務名が資料に沿っていない: ${newBiz.name}`);
    if (sameBiz.isNewBusiness) problems.push(`既存業務の補足資料を新業務と誤判定: ${sameBiz.name}`);
    const secs = Math.round((Date.now() - started) / 1000);
    if (problems.length === 0) {
      console.log(`✅ PASS (${secs}s) 新業務の検知: 別業務は提案し、補足は提案しない`);
    } else {
      failed++;
      console.log(`❌ FAIL (${secs}s) 新業務の検知: 別業務は提案し、補足は提案しない`);
      for (const pr of problems) console.log(`   - ${pr}`);
    }
  }

  for (const c of CASES) {
    const skills = await prepareSkillsForChat(c.boardId);
    const started = Date.now();
    const res = await generate(
      c.boardId,
      [
        {
          role: "user",
          content: `${c.message}\n\n---\n現在の User Story Map(この内容をベースに更新してください):\n${JSON.stringify(c.map ?? { actors: [], activities: [] })}`,
        },
      ],
      skills,
    );
    const mapJson = JSON.stringify(res.storyMap);
    const used = res.usedSkills ?? [];

    const problems: string[] = [];
    for (const s of c.usedMustInclude ?? [])
      if (!used.includes(s)) problems.push(`参照されるべき ${s} が未参照(実際: ${used.join(",") || "なし"})`);
    if (c.usedMustBeEmpty && used.length > 0)
      problems.push(`参照不要なのに読んだ: ${used.join(",")}`);
    for (const t of c.mapMustInclude ?? [])
      if (!mapJson.includes(t)) problems.push(`マップに「${t}」が無い`);
    for (const t of c.mapMustExclude ?? [])
      if (mapJson.includes(t)) problems.push(`マップに「${t}」が混入`);
    for (const t of c.replyMustInclude ?? [])
      if (!res.reply.includes(t)) problems.push(`reply に「${t}」が無い`);

    const secs = Math.round((Date.now() - started) / 1000);
    if (problems.length === 0) {
      console.log(`✅ PASS (${secs}s) ${c.name}`);
    } else {
      failed++;
      console.log(`❌ FAIL (${secs}s) ${c.name}`);
      for (const p of problems) console.log(`   - ${p}`);
      console.log(`   reply: ${res.reply.slice(0, 120)}`);
    }
  }

  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`\n${CASES.length + 3 - failed}/${CASES.length + 3} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
