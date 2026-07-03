// 知識ベース(ユースケース + 永続化 + skill レンダリング)の特性テスト(L1)。
//
// テスト戦略(TESTING.md): モックは使わない。LLM 境界だけ USM_FAKE_LLM=1 の
// 決定的フェイク(infrastructure/agent/fake.ts)に差し替え、ファイル IO・
// ドメイン・skill 描画は本物を通す。AI の出力はアップロードするファイル本文の
// ディレクティブ(KB| / NOKB / CONFLICTS_JSON: / REVISE|)で制御する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoard } from "@/infrastructure/boards";
import {
  addSource,
  deleteEntry,
  deleteSource,
  dismissConflict,
  getCategoryMarkdown,
  getKnowledgeState,
  getSourceEntries,
  getSourceMarkdown,
  prepareSkillsForChat,
  proposeEntryRevision,
  reextractSource,
  renderCommonSkills,
  setSourceEnabled,
  updateEntry,
} from "@/infrastructure/context";

let tmp: string;
let BOARD: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "usm-kb-"));
  process.env.DATA_DIR = tmp;
  process.env.USM_FAKE_LLM = "1";
  // 共通知識は「登録済みボード + _common」から合成されるため、ボードとして登録する
  BOARD = (await createBoard("テスト業務")).id;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.USM_FAKE_LLM;
  await fs.rm(tmp, { recursive: true, force: true });
});

// 抽出結果を制御する資料本文(1 行 1 エントリ)
const DOC_A = [
  "KB|flows|承認ルール|1,000万円超は部長承認|false",
  "KB|terms|送金指示番号|英数字12桁|false",
].join("\n");
const DOC_MIXED = [
  "KB|flows|承認ルール|業務固有|false",
  "KB|terms|BSAD|基本設計書の略称|true",
].join("\n");

const skillPath = (scope: string, name: string) =>
  path.join(tmp, "workspaces", scope, ".claude", "skills", name, "SKILL.md");
const originalPath = (scope: string, id: string, fileName: string) =>
  path.join(tmp, "workspaces", scope, "sources", id, fileName);

describe("知識ベース", () => {
  it("addSource: 原ファイル保存 + 抽出エントリ + カテゴリ skill を生成する", async () => {
    const state = await addSource(BOARD, "memo.txt", Buffer.from(DOC_A));

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].entryCount).toBe(2);
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(1);

    // 原ファイルが保存されている
    await expect(
      fs.readFile(originalPath(BOARD, state.sources[0].id, "memo.txt"), "utf-8"),
    ).resolves.toBe(DOC_A);

    // skill がレンダリングされ、description にタイトルが入る
    const skill = await fs.readFile(skillPath(BOARD, "kb-flows"), "utf-8");
    expect(skill).toContain("name: kb-flows");
    expect(skill).toContain("承認ルール");
    expect(skill).toContain("_出典: memo.txt_");
  });

  it("AI が common と判定したエントリは kb-common-* へ、それ以外は kb-* へ入る", async () => {
    await addSource(BOARD, "設計書.txt", Buffer.from(DOC_MIXED));

    // 業務固有 → ボードの kb-flows(kb-terms は作られない)
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).resolves.toBeUndefined();
    await expect(fs.access(skillPath(BOARD, "kb-terms"))).rejects.toThrow();

    // 共通 → _common の kb-common-terms に合成され、チャット準備で提示される
    const common = await fs.readFile(skillPath("_common", "kb-common-terms"), "utf-8");
    expect(common).toContain("BSAD");
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-flows", "kb-common-terms"]),
    );

    // 別ボードのチャット準備でも共通知識だけが同期される
    const other = (await createBoard("別業務")).id;
    expect(await prepareSkillsForChat(other)).toEqual(["kb-common-terms"]);
    await expect(fs.access(skillPath(other, "kb-common-terms"))).resolves.toBeUndefined();
  });

  it("setSourceEnabled(false) で業務固有・共通の両 skill から消え、戻すと再生される", async () => {
    const state = await addSource(BOARD, "memo.txt", Buffer.from(DOC_MIXED));
    const id = state.sources[0].id;

    await setSourceEnabled(BOARD, id, false);
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).rejects.toThrow();
    await expect(fs.access(skillPath("_common", "kb-common-terms"))).rejects.toThrow();
    expect(await prepareSkillsForChat(BOARD)).toEqual([]);

    await setSourceEnabled(BOARD, id, true);
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-flows", "kb-common-terms"]),
    );
  });

  it("deleteSource でエントリ・skill・原ファイルが消える(共通へ振り分けた分も)", async () => {
    const state = await addSource(BOARD, "memo.txt", Buffer.from(DOC_MIXED));
    const next = await deleteSource(BOARD, state.sources[0].id);
    expect(next.sources).toHaveLength(0);
    expect(next.categories.every((c) => c.count === 0)).toBe(true);
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).rejects.toThrow();
    await expect(fs.access(skillPath("_common", "kb-common-terms"))).rejects.toThrow();
  });

  it("reextractSource は原ファイルから再抽出してエントリを差し替える", async () => {
    const state = await addSource(BOARD, "memo.txt", Buffer.from(DOC_A));
    const id = state.sources[0].id;

    // 原ファイルを改訂(抽出結果が変わる)
    await fs.writeFile(
      originalPath(BOARD, id, "memo.txt"),
      "KB|background|課題|月末に滞留する|false",
      "utf-8",
    );
    const next = await reextractSource(BOARD, id);
    expect(next.sources[0].entryCount).toBe(1);
    expect(next.categories.find((c) => c.category === "background")?.count).toBe(1);
    expect(next.categories.find((c) => c.category === "flows")?.count).toBe(0);
  });

  it("カテゴリ閲覧はボード + 共通をマージし、他スコープ由来の共通には(共通)が付く", async () => {
    await addSource(BOARD, "board.txt", Buffer.from("KB|terms|ボード用語|b|false"));
    await addSource(null, "common.txt", Buffer.from("KB|terms|共通用語|c|true"));

    const { markdown } = await getCategoryMarkdown(BOARD, "terms");
    expect(markdown).toContain("ボード用語");
    expect(markdown).toContain("共通用語");
    expect(markdown).toContain("_出典: common.txt(共通)_");
  });

  it("ソース閲覧は出典確認用の Markdown を返し、共通エントリに印を付ける", async () => {
    const state = await addSource(BOARD, "memo.txt", Buffer.from(DOC_MIXED));
    const { meta, markdown } = await getSourceMarkdown(BOARD, state.sources[0].id);
    expect(meta.fileName).toBe("memo.txt");
    expect(markdown).toContain("## 承認ルール");
    expect(markdown).toContain("## BSAD(業務横断の共通知識)");
  });

  it("未対応の拡張子・空の抽出はエラーにする", async () => {
    await expect(addSource(BOARD, "x.docx", Buffer.from("x"))).rejects.toThrow("未対応");
    await expect(addSource(BOARD, "empty.txt", Buffer.from("NOKB"))).rejects.toThrow(
      "抽出できません",
    );
  });
});

describe("共通知識の管理ビュー(/knowledge)", () => {
  it("共通管理画面からの追加は AI の判定によらず必ず共通になる", async () => {
    // common=false のディレクティブでも、共通ビュー経由なら共通になる
    await addSource(null, "全社規程.txt", Buffer.from("KB|flows|全社承認標準|500万円超は部長承認|false"));
    const skill = await fs.readFile(skillPath("_common", "kb-common-flows"), "utf-8");
    expect(skill).toContain("全社承認標準");
  });

  it("getKnowledgeState(null) はここで追加した資料 + 全ボードの共通知識を返す", async () => {
    await addSource(
      BOARD,
      "board.txt",
      Buffer.from(["KB|terms|共通用語|c|true", "KB|flows|業務ルール|b|false"].join("\n")),
    );
    await addSource(null, "common.txt", Buffer.from("KB|terms|全社用語|g|true"));

    const state = await getKnowledgeState(null);
    // 資料一覧は共通管理画面で追加したものだけ(ボードの資料は各ボードで管理)
    expect(state.sources.map((s) => s.fileName)).toEqual(["common.txt"]);
    // カテゴリにはボードの資料から振り分けられた共通知識も集まる
    expect(state.categories.find((c) => c.category === "terms")?.count).toBe(2);
    // 業務固有の知識は共通ビューに混ざらない
    expect(state.categories.find((c) => c.category === "flows")?.count).toBe(0);
  });
});

describe("旧データ(資料単位スコープ)からの移行", () => {
  it("common フラグの無い旧エントリは、_common 由来なら共通・ボード由来なら業務固有になる", async () => {
    const { writeJson, sourcesFile, knowledgeFile } = await import(
      "@/infrastructure/context/repository"
    );
    await writeJson(sourcesFile(BOARD), [
      { id: "b1", fileName: "旧業務.txt", enabled: true, entryCount: 1, uploadedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await writeJson(knowledgeFile(BOARD), [
      { id: "e1", sourceId: "b1", category: "flows", title: "旧業務ルール", content: "x" },
    ]);
    await writeJson(sourcesFile("_common"), [
      { id: "c1", fileName: "旧共通.txt", enabled: true, entryCount: 1, uploadedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await writeJson(knowledgeFile("_common"), [
      { id: "e2", sourceId: "c1", category: "terms", title: "旧共通用語", content: "y" },
    ]);
    await renderCommonSkills();

    const common = await fs.readFile(skillPath("_common", "kb-common-terms"), "utf-8");
    expect(common).toContain("旧共通用語");
    // ボードの旧エントリは業務固有として扱われ、共通には混ざらない
    await expect(fs.access(skillPath("_common", "kb-common-flows"))).rejects.toThrow();
    expect(await prepareSkillsForChat(BOARD)).toEqual(
      expect.arrayContaining(["kb-common-terms"]),
    );
  });
});

describe("エントリ単位の編集(AI 協働)", () => {
  const seedSource = async () => {
    const state = await addSource(BOARD, "設計書.txt", Buffer.from(DOC_MIXED));
    const { entries } = await getSourceEntries(BOARD, state.sources[0].id);
    return { sourceId: state.sources[0].id, entries };
  };

  it("updateEntry: 保存で edited になり skill に反映、common の付け替えもできる", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    await updateEntry(BOARD, sourceId, rule.id, {
      title: "承認ルール(改)",
      content: "2億円超は役員承認",
      common: true, // 業務固有 → 共通へ付け替え
    });

    const saved = (await getSourceEntries(BOARD, sourceId)).entries.find(
      (e) => e.id === rule.id,
    )!;
    expect(saved.edited).toBe(true);
    expect(saved.common).toBe(true);
    // 業務固有 skill からは消え、共通 skill に入る
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).rejects.toThrow();
    const common = await fs.readFile(skillPath("_common", "kb-common-flows"), "utf-8");
    expect(common).toContain("2億円超は役員承認");
  });

  it("再抽出しても edited エントリは上書きされない", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    await updateEntry(BOARD, sourceId, rule.id, {
      title: "承認ルール(人が修正)",
      content: "2億円超は役員承認",
      common: false,
    });

    const state = await reextractSource(BOARD, sourceId);
    const after = (await getSourceEntries(BOARD, sourceId)).entries;
    // 人が直した方は残り、再抽出分も追加される
    expect(after.some((e) => e.title === "承認ルール(人が修正)")).toBe(true);
    expect(after.some((e) => e.title === "承認ルール" && !e.edited)).toBe(true);
    expect(state.sources[0].entryCount).toBe(after.length);
  });

  it("deleteEntry: 1 件だけ消えて entryCount と skill が追従する", async () => {
    const { sourceId, entries } = await seedSource();
    const bsad = entries.find((e) => e.title === "BSAD")!;
    const state = await deleteEntry(BOARD, sourceId, bsad.id);
    expect(state.sources[0].entryCount).toBe(1);
    await expect(fs.access(skillPath("_common", "kb-common-terms"))).rejects.toThrow();
    await expect(fs.access(skillPath(BOARD, "kb-flows"))).resolves.toBeUndefined();
  });

  it("proposeEntryRevision: 指示に沿った修正案が返る(保存はされない)", async () => {
    const { sourceId, entries } = await seedSource();
    const rule = entries.find((e) => e.title === "承認ルール")!;
    const revision = await proposeEntryRevision(
      BOARD,
      sourceId,
      rule.id,
      "REVISE|承認ルール|2億円超は役員承認|false",
    );
    expect(revision.content).toContain("2億");
    expect(revision.note).toBeTruthy();
    // 提案だけで保存はされていない
    const unchanged = (await getSourceEntries(BOARD, sourceId)).entries.find(
      (e) => e.id === rule.id,
    )!;
    expect(unchanged.content).toBe("業務固有");
  });
});

describe("鮮度(同名資料の更新)と矛盾検出", () => {
  it("同名ファイルの追加は資料の更新になる(edited は保持・原資料は差し替え)", async () => {
    const first = await addSource(BOARD, "設計.txt", Buffer.from(DOC_A));
    const sourceId = first.sources[0].id;
    const { entries } = await getSourceEntries(BOARD, sourceId);
    await updateEntry(BOARD, sourceId, entries[0].id, {
      title: "承認ルール(人が修正)",
      content: "2億円超は役員承認",
      common: false,
    });

    // 同名で再アップロード(改訂版)
    const next = await addSource(
      BOARD,
      "設計.txt",
      Buffer.from("KB|flows|新ルール|即時送金は上限500万円|false"),
    );

    expect(next.sources).toHaveLength(1); // 増えない = 更新
    expect(next.sources[0].id).toBe(sourceId);
    const after = (await getSourceEntries(BOARD, sourceId)).entries;
    expect(after.some((e) => e.title === "承認ルール(人が修正)")).toBe(true); // edited 保持
    expect(after.some((e) => e.title === "新ルール")).toBe(true);
    expect(after.some((e) => e.title === "送金指示番号")).toBe(false); // 旧の未編集分は消える
    // 原資料が差し替わっている
    await expect(
      fs.readFile(originalPath(BOARD, sourceId, "設計.txt"), "utf-8"),
    ).resolves.toContain("新ルール");
  });

  it("取り込み時に既存知識と突合し、矛盾が state に載る → 解決済みで消える", async () => {
    await addSource(BOARD, "旧規程.txt", Buffer.from(DOC_A));

    const conflictDirective =
      'CONFLICTS_JSON:[{"topic":"送金の承認閾値","newClaim":"2億円超は役員承認","existingSource":"旧規程.txt","existingClaim":"1,000万円超は部長承認"}]';
    const state = await addSource(
      BOARD,
      "新規程.txt",
      Buffer.from(`KB|flows|承認ルール|${conflictDirective}|false`),
    );

    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].topic).toBe("送金の承認閾値");
    // 既存側の出典 id が解決されている(資料削除時の掃除用)
    const oldId = state.sources.find((s) => s.fileName === "旧規程.txt")!.id;
    expect(state.conflicts[0].existingSourceId).toBe(oldId);

    const cleared = await dismissConflict(BOARD, state.conflicts[0].id);
    expect(cleared.conflicts).toHaveLength(0);
  });

  it("資料を削除すると関連する矛盾も消える", async () => {
    await addSource(BOARD, "旧.txt", Buffer.from(DOC_A));
    const state = await addSource(
      BOARD,
      "新.txt",
      Buffer.from(
        'KB|flows|A|CONFLICTS_JSON:[{"topic":"t","newClaim":"n","existingSource":"旧.txt","existingClaim":"e"}]|false',
      ),
    );
    expect(state.conflicts).toHaveLength(1);

    const newSourceId = state.sources.find((s) => s.fileName === "新.txt")!.id;
    const after = await deleteSource(BOARD, newSourceId);
    expect(after.conflicts).toHaveLength(0);
  });

  it("矛盾検出が失敗しても取り込み自体は成功する(warn のみ)", async () => {
    await addSource(BOARD, "既存.txt", Buffer.from(DOC_A));
    // 壊れた CONFLICTS_JSON → 検出処理が throw する
    const state = await addSource(
      BOARD,
      "新規.txt",
      Buffer.from("KB|flows|B|CONFLICTS_JSON:{壊れたJSON|false"),
    );
    expect(state.sources).toHaveLength(2); // 取り込みは成功
    expect(state.conflicts).toEqual([]);
  });
});
