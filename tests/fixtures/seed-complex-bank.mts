// 複雑システムフィクスチャ(SORA銀行)を DATA_DIR へシードする CLI。
//
//   npm run seed:complex                    … dev の data/ へ(既存データにマージ)
//   DATA_DIR=/tmp/foo npm run seed:complex  … 任意のデータディレクトリへ
//
// 冪等: cx- プレフィクスのボード・資料だけを入れ替える。既存データは消さない。

import { BOARDS, SOURCES, seedComplexBank } from "./complex-bank";

await seedComplexBank();

console.log(`シード完了 (DATA_DIR=${process.env.DATA_DIR || "data"})`);
console.log(`ボード ${BOARDS.length} 件:`);
for (const b of BOARDS) console.log(`  - ${b.name} (${b.id})`);
const entryCount = SOURCES.reduce((n, s) => n + s.entries.length, 0);
console.log(
  `共有知識: ${SOURCES.length} 資料 / ${entryCount} エントリ(off 資料 ${SOURCES.filter((s) => !s.enabled).length} 件を含む)`,
);
