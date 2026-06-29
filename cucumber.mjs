// Cucumber 設定。E2E(@manual でないもの)だけを実行する。
// TypeScript のステップ/サポートは tsx ローダー(package.json の test:e2e)で読み込む。
export default {
  paths: ["features/**/*.feature"],
  import: ["features/support/**/*.ts", "features/steps/**/*.ts"],
  tags: "not @manual",
  format: ["progress"],
};
