// インフラ層: データ置き場の場所決め。
//
// ボード = 業務。ボードごとにワークスペース(マップ・会話・版履歴・ドメイン知識)を持つ:
//   <DATA_DIR>/
//     boards.json                  ← ボード一覧
//     workspaces/<boardId>/        ← 各ボードのワークスペース
//     workspaces/_common/          ← 業務横断の共通知識(マップは持たない)
//
// DATA_DIR でデータ全体の置き場を差し替えられる(E2E の隔離用。省略時 data/)。

import path from "path";

/** 業務横断の共通知識を置く擬似ボード ID */
export const COMMON_SCOPE = "_common";

export function dataRoot(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), "data");
}

/** ボード(または _common)のワークスペースディレクトリ */
export function workspaceDir(scope: string): string {
  return path.join(dataRoot(), "workspaces", scope);
}
