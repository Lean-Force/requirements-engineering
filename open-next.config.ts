import { defineCloudflareConfig } from "@opennextjs/cloudflare/config";

// API ルートは force-dynamic で都度生成するため、増分キャッシュ(R2/D1)は使わない。
// 必要になったら incrementalCache を追加する。
export default defineCloudflareConfig({});
