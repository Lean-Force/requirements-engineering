// インフラ層: アップロードファイル(Excel / CSV / PDF / テキスト)を Markdown へ変換する。
//
// Excel はシートごとに分割し、表として成立していれば Markdown テーブル、
// 1 列だけの資料(ヒアリングメモ等)は素のテキストとして出力する。
// PDF はテキスト層を抽出し、ページ見出し付きの 1 資料にまとめる
// (スキャン PDF などテキスト層が無いものは取り込みエラーにする)。
// セル結合・方眼紙レイアウト・複雑な組版は崩れることがあるため、
// 変換結果はコンテキストパネルから資料単位で無効化できるようにしている(store 側)。

import * as XLSX from "xlsx";
import { extractText } from "unpdf";

/** 変換結果の 1 資料(Excel なら 1 シート、PDF なら 1 ファイル) */
export interface ParsedDoc {
  /** Excel / CSV 由来のときのみ(シート名) */
  sheetName?: string;
  /** Markdown 化した本文 */
  markdown: string;
  /** 一覧・AI への常駐提示に使う 1 行説明(内容の要約) */
  description: string;
}

const TEXT_EXTENSIONS = [".md", ".txt"];
const SHEET_EXTENSIONS = [".xlsx", ".xls", ".csv"];
const PDF_EXTENSIONS = [".pdf"];

export const SUPPORTED_EXTENSIONS = [
  ...SHEET_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...TEXT_EXTENSIONS,
];

export function isSupportedFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** ファイル 1 つを資料の配列へ変換する(Excel は複数シート → 複数資料) */
export async function parseFile(
  fileName: string,
  buffer: Buffer,
): Promise<ParsedDoc[]> {
  const lower = fileName.toLowerCase();

  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    const text = buffer.toString("utf-8").trim();
    if (!text) return [];
    return [{ markdown: text, description: summarizeText(text) }];
  }

  if (PDF_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return parsePdf(buffer);
  }

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const docs: ParsedDoc[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const doc = rowsToDoc(rows, sheetName);
    if (doc) docs.push(doc);
  }
  return docs;
}

// ---- PDF -----------------------------------------------------------------

async function parsePdf(buffer: Buffer): Promise<ParsedDoc[]> {
  const { totalPages, text } = await extractText(new Uint8Array(buffer), {
    mergePages: false,
  });

  const pages = text.map((t) => t.trim());
  if (pages.every((t) => t === "")) {
    throw new Error(
      "PDF からテキストを抽出できませんでした(画像のみのスキャン PDF の可能性があります)",
    );
  }

  // ページ見出し付きで 1 資料にまとめる(空ページは飛ばす)
  const markdown = pages
    .map((t, i) => (t === "" ? null : `## ページ ${i + 1}\n\n${t}`))
    .filter((s): s is string => s !== null)
    .join("\n\n");

  const firstText = pages.find((t) => t !== "") ?? "";
  return [
    {
      markdown,
      description: `${totalPages}ページの PDF — ${summarizeText(firstText)}`,
    },
  ];
}

// ---- Excel / CSV ----------------------------------------------------------

function rowsToDoc(rows: string[][], sheetName: string): ParsedDoc | null {
  // 末尾の空行・全行に共通する空列を落とす
  const trimmed = rows
    .map((r) => r.map((c) => String(c ?? "").trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (trimmed.length === 0) return null;

  const width = Math.max(...trimmed.map((r) => lastFilledIndex(r) + 1));
  const table = trimmed.map((r) => {
    const row = r.slice(0, width);
    while (row.length < width) row.push("");
    return row;
  });

  const markdown =
    width <= 1 ? table.map((r) => r[0]).join("\n") : toMarkdownTable(table);

  const header = table[0].filter((c) => c !== "").slice(0, 6);
  const description =
    width <= 1
      ? summarizeText(markdown)
      : `${table.length - 1}行の表(見出し: ${header.join(" / ")})`;

  return { sheetName, markdown, description };
}

function lastFilledIndex(row: string[]): number {
  for (let i = row.length - 1; i >= 0; i--) {
    if (row[i] !== "") return i;
  }
  return -1;
}

function toMarkdownTable(rows: string[][]): string {
  const escape = (c: string) => c.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const [header, ...body] = rows;
  const line = (r: string[]) => `| ${r.map(escape).join(" | ")} |`;
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  return [line(header), separator, ...body.map(line)].join("\n");
}

// ---- 共通 ------------------------------------------------------------------

function summarizeText(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const summary = firstLine.trim().slice(0, 60);
  return summary || "テキスト資料";
}
