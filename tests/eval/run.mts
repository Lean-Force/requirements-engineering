// レベル3: AI が知識を「必要なときに読み、正しく使うか」の eval(実 LLM を呼ぶ)。
//
//   npm run eval
//
// フィクスチャは tests/fixtures/complex-bank(複数ボードの複雑システム =
// SORA銀行 6 業務)。知識は kb-* skill としてオンデマンド読み込みされるため、
// 判定は次の 3 軸で行う:
//   - usedSkills(generate が記録する「実際に読んだ skill」)の包含 / 空
//   - structured output(マップ JSON)への事実の包含 / 除外
//   - reply への包含
// CI 常時ではなく、リリース前・プロンプト変更時に手動で回す想定
// (1ケース $0.1〜0.3 / 全体で数分)。LLM のゆれで際どいケースは、
// 期待を「事実の存在」に留めて文言一致を避ける。
//
// 引数でケースを絞れる(名前の部分一致。抽出・矛盾・新業務の
// パイプライン eval はスキップされる):
//   npm run eval -- 用語

import { promises as fs } from "fs";
import os from "os";
import path from "path";

// .env.local から LLM 接続設定を読む(Next.js の自動読み込みは CLI では効かない)
const envLocal = path.join(process.cwd(), ".env.local");
try {
  for (const line of (await fs.readFile(envLocal, "utf-8")).split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* .env.local が無ければ既存の env で動く */
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-eval-"));
process.env.DATA_DIR = tmp;

// DATA_DIR を確定させてから、データを触るモジュールを読み込む
const { detectConflicts, detectNewBusiness, extractKnowledge, extractKnowledgeMulti, generate } =
  await import("../../infrastructure/agent");
const { buildChatContext, syncKnowledgeSkills } = await import(
  "../../infrastructure/context/knowledge"
);
const { loadStoryMap } = await import("../../infrastructure/storage");
const { seedComplexBank } = await import("../fixtures/complex-bank");

// ---- チャットのケース定義 -----------------------------------------------------

interface EvalCase {
  name: string;
  boardId: string;
  message: string;
  /** 現在のマップ(省略時はシード済みのボードのマップを使う) */
  map?: unknown;
  mapMustInclude?: string[];
  mapMustExclude?: string[];
  replyMustInclude?: string[];
  /** 読まれているべき skill(部分一致) */
  skillsMustInclude?: string[];
  /** true なら skill を 1 つも読んでいないこと */
  skillsMustBeEmpty?: boolean;
}

const CASES: EvalCase[] = [
  {
    name: "知識(業務ルール)を読んで事実を正確に反映する",
    boardId: "cx-domestic",
    message:
      "組み戻しの場面に、組み戻し手数料の金額を本文に明記したストーリーを追加して。金額は社内の決まりに従って。",
    mapMustInclude: ["880"],
    skillsMustInclude: ["kb-flows"],
  },
  {
    name: "off にした資料(旧規程)の知識は使われない",
    boardId: "cx-domestic",
    message:
      "受付の流れに「カットオフを確認する」場面を追加して、カットオフ時刻を本文に明記して。時刻は社内の決まりに従って。",
    mapMustInclude: ["15:00"],
    mapMustExclude: ["14:00"], // 旧規程(off)の時刻が見えたら漏れ
  },
  {
    name: "機械的な操作では skill を読まず、知識のノイズも混入しない",
    boardId: "cx-support",
    message: "アクター「テスト太郎」を1人追加して。それ以外は何も変えないで。",
    mapMustInclude: ["テスト太郎"],
    mapMustExclude: ["880", "15:00"],
    skillsMustBeEmpty: true,
  },
  {
    name: "用語の質問には kb-terms を読んで答える",
    boardId: "cx-foreign",
    message:
      "SHA / OUR / BEN の違いを reply で説明して。マップは変えないで。",
    replyMustInclude: ["負担"],
    skillsMustInclude: ["kb-terms"],
  },
  {
    name: "データ定義(値域)を読んで正確に反映する",
    boardId: "cx-domestic",
    message:
      "送金種別の選択肢を、それぞれストーリーとして受付の場面に明記して追加して。",
    mapMustInclude: ["即時", "予約"],
    skillsMustInclude: ["kb-data"],
  },
  {
    name: "他業務の合意済みマップは skill を読まずに参照できる(常時注入)",
    boardId: "cx-support",
    message:
      "「国内送金」の業務で確定(チーム合意)済みになっている承認まわりの決定を reply で教えて。マップは変えないで。",
    replyMustInclude: ["1,000万"],
  },
  {
    name: "他業務の合意済みマップとの齟齬を指摘する",
    boardId: "cx-loan",
    message:
      "契約・実行の前に「融資実行用の口座を郵送で申し込み、開設完了まで2週間待つ」という場面を追加して。他の業務ボードで合意済みの内容と食い違う点があれば reply で指摘して。",
    replyMustInclude: ["eKYC"],
  },
  {
    name: "確定(fixed)要素の変更依頼は拒み、確定解除を案内する",
    boardId: "cx-domestic",
    message: "「1,000万円」の承認ストーリーの金額を3,000万円に変更して。",
    mapMustInclude: ["1,000万"],
    mapMustExclude: ["3,000万"],
    replyMustInclude: ["確定"],
  },
  {
    name: "随時の業務を standalone として時系列外に置く",
    boardId: "cx-support",
    message:
      "「振り込め詐欺の注意喚起」を場面として追加して。これは流れとは独立で、随時行う業務です。",
    mapMustInclude: ["注意喚起", '"standalone":true'],
  },
  {
    name: "リリースラインを切る(MVP と後続を分ける)",
    boardId: "cx-onboarding",
    message:
      "リリースを MVP と「フェーズ2」に切って。申込〜口座開設の流れは MVP、初回ログイン体験の改善は後続。",
    mapMustInclude: ['"release"', '"releases"', "フェーズ2"],
    replyMustInclude: ["MVP"],
  },
];

// ---- 実行 -------------------------------------------------------------------

const filter = process.argv[2];

async function main() {
  await seedComplexBank();
  let failed = 0;

  // ---- 抽出: 観点別 5 パスの再現率(vs 1 パス)+ common 自動判定 --------------
  if (!filter) {
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
    // common 自動判定(5 パス側 = 本番経路で確認)。
    // カテゴリ別バイアス: terms は共通寄り、flows は業務固有寄り。
    // 観点重複で同じ事実が別カテゴリにも現れるため、カテゴリを絞って判定する
    const bsad = multi.find((e) => e.category === "terms" && (e.title + e.content).includes("BSAD"));
    const rule = multi.find((e) => e.category === "flows" && (e.title + e.content).includes("1,000万"));
    if (bsad && bsad.common !== true) problems.push("全社用語 BSAD(terms)が共通になっていない");
    if (rule && rule.common !== false) problems.push("業務の承認ルール(flows)が業務固有になっていない");

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
  if (!filter) {
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
    else if (!`${hit.newClaim}${hit.existingClaim}`.includes("役員"))
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
  if (!filter) {
    const started = Date.now();
    const [newBiz, sameBiz] = await Promise.all([
      detectNewBusiness(
        "証券口座連携フロー.xlsx",
        [
          "証券口座連携: 銀行口座と証券口座を紐づけ、余資を自動スイープする。",
          "スイープの実行タイミング: 毎営業日 16:00。",
        ].join("\n"),
        ["国内送金", "口座開設"],
        "共通知識の管理画面(特定の業務に紐づかない)",
      ),
      detectNewBusiness(
        "送金補足.xlsx",
        "送金の承認ルール補足: 1,000万円超は部長承認。休日受付は翌営業日扱い。",
        ["国内送金"],
        "業務「国内送金」のボード",
      ),
    ]);
    const problems: string[] = [];
    if (!newBiz.isNewBusiness) problems.push("別業務(証券口座連携)の資料が新業務と判定されていない");
    else if (!newBiz.name.includes("証券")) problems.push(`業務名が資料に沿っていない: ${newBiz.name}`);
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

  // ---- チャット: skill のオンデマンド読み込みと事実の正確な反映 ----------------
  const chatCases = CASES.filter((c) => !filter || c.name.includes(filter));
  for (const c of chatCases) {
    await syncKnowledgeSkills(c.boardId);
    const map = (c.map ?? (await loadStoryMap(c.boardId))) as never;
    const chatContext = await buildChatContext(c.boardId, map);
    const started = Date.now();
    const res = await generate(
      c.boardId,
      [{ role: "user", content: c.message }],
      chatContext,
    );
    const mapJson = JSON.stringify(res.storyMap);

    const problems: string[] = [];
    for (const t of c.mapMustInclude ?? [])
      if (!mapJson.includes(t)) problems.push(`マップに「${t}」が無い`);
    for (const t of c.mapMustExclude ?? [])
      if (mapJson.includes(t)) problems.push(`マップに「${t}」が混入`);
    for (const t of c.replyMustInclude ?? [])
      if (!res.reply.includes(t)) problems.push(`reply に「${t}」が無い`);
    for (const s of c.skillsMustInclude ?? [])
      if (!res.usedSkills.some((u) => u.includes(s)))
        problems.push(`skill「${s}」を読んでいない(読んだ: ${res.usedSkills.join(", ") || "なし"})`);
    if (c.skillsMustBeEmpty && res.usedSkills.length > 0)
      problems.push(`不要な skill を読んだ: ${res.usedSkills.join(", ")}`);

    const secs = Math.round((Date.now() - started) / 1000);
    if (problems.length === 0) {
      console.log(
        `✅ PASS (${secs}s) ${c.name}` +
        (res.usedSkills.length > 0 ? ` [read: ${res.usedSkills.join(", ")}]` : ""),
      );
    } else {
      failed++;
      console.log(`❌ FAIL (${secs}s) ${c.name}`);
      for (const p of problems) console.log(`   - ${p}`);
      console.log(`   reply: ${res.reply.slice(0, 120)}`);
    }
  }

  await fs.rm(tmp, { recursive: true, force: true });
  const total = chatCases.length + (filter ? 0 : 3);
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
