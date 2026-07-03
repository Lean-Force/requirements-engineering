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
import { extractKnowledge, generate } from "../../infrastructure/agent";
import {
  knowledgeFile,
  sourcesFile,
  writeJson,
} from "../../infrastructure/context/repository";
import { renderCommonSkills, renderSkills, prepareSkillsForChat } from "../../infrastructure/context/skills";
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

  let failed = 0;

  // ---- 抽出時のスコープ自動判定(業務固有 / 業務横断) -----------------------
  {
    const started = Date.now();
    const extracted = await extractKnowledge(
      "送金業務設計書.md",
      [
        "# 全社用語",
        "- BSAD: 基本設計書の社内略称(全社共通)。",
        "# 送金の承認ルール",
        "- 1,000万円を超える送金は部長承認が必要。",
      ].join("\n"),
    );
    const problems: string[] = [];
    const find = (kw: string) => extracted.find((e) => (e.title + e.content).includes(kw));
    const bsad = find("BSAD");
    const rule = find("部長承認") ?? find("承認");
    if (!bsad) problems.push("BSAD が抽出されていない");
    else if (bsad.common !== true) problems.push("全社用語 BSAD が共通(common=true)に振り分けられていない");
    if (!rule) problems.push("承認ルールが抽出されていない");
    else if (rule.common !== false) problems.push("業務の承認ルールが業務固有(common=false)になっていない");
    const secs = Math.round((Date.now() - started) / 1000);
    if (problems.length === 0) {
      console.log(`✅ PASS (${secs}s) 抽出時に業務固有/業務横断を自動判定する`);
    } else {
      failed++;
      console.log(`❌ FAIL (${secs}s) 抽出時に業務固有/業務横断を自動判定する`);
      for (const pr of problems) console.log(`   - ${pr}`);
      console.log(`   extracted: ${JSON.stringify(extracted.map((e) => ({ t: e.title, common: e.common })))}`);
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
          content: `${c.message}\n\n---\n現在の User Story Map(この内容をベースに更新してください):\n{"actors":[],"activities":[]}`,
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
  console.log(`\n${CASES.length + 1 - failed}/${CASES.length + 1} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
