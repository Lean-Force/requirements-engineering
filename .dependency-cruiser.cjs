/**
 * モジュールの責務定義(依存ルール)。ここが層構造の正であり、違反は npm run check:deps で落ちる。
 *
 *   domain/          … 純粋なドメイン層。他のどの層にも依存しない(node_modules も不可)
 *   contracts.ts     … 層をまたぐ DTO。依存してよいのは domain の型だけ
 *   infrastructure/  … 外界との接続。domain / contracts に依存してよい。ui / app は不可
 *   ui/              … 表現層。domain / contracts / ui 内部のみ。infrastructure / app は不可
 *                      (データ取得は app のページが行い、props で渡す)
 *   app/             … 配線。すべてに依存してよい(ここだけが全部を知る)
 */
module.exports = {
  forbidden: [
    {
      name: "domain は純粋(プロジェクト内の他層に依存しない)",
      severity: "error",
      from: { path: "^domain" },
      to: { path: "^(infrastructure|ui|app|contracts)" },
    },
    {
      name: "domain は node_modules にも依存しない",
      severity: "error",
      from: { path: "^domain" },
      to: { dependencyTypes: ["npm", "npm-dev"] },
    },
    {
      name: "contracts が依存してよいのは domain だけ",
      severity: "error",
      from: { path: "^contracts\\.ts$" },
      to: { path: "^(infrastructure|ui|app)" },
    },
    {
      name: "infrastructure は ui / app に依存しない",
      severity: "error",
      from: { path: "^infrastructure" },
      to: { path: "^(ui|app)" },
    },
    {
      name: "ui は infrastructure / app に依存しない(データは props で受け取る)",
      severity: "error",
      from: { path: "^ui" },
      to: { path: "^(infrastructure|app)" },
    },
    {
      name: "循環依存の禁止",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
