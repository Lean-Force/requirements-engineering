import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

// `next dev` でも Cloudflare のバインディング(KV など)を getCloudflareContext() 経由で
// 使えるようにする。本番ビルド(opennextjs-cloudflare build)には影響しない。
initOpenNextCloudflareForDev();

export default nextConfig;
