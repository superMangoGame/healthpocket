import type { NextConfig } from "next";

/**
 * 双模式构建：
 * - 默认（开发 / Docker standalone）：行为与改造前一致
 * - Obsidian 插件模式（HEALTHPOCKET_EXPORT=1）：静态导出 + basePath，
 *   产物由 scripts/build-plugin-app.sh 拷贝进 lib/app，经插件同源
 *   /heathpocket/app/* 路由服务，API 走 /heathpocket/api 反向代理
 */
const pluginExport = process.env.HEALTHPOCKET_EXPORT === "1";
const basePath = pluginExport ? (process.env.HEALTHPOCKET_BASE_PATH || "/heathpocket/app") : "";

const nextConfig: NextConfig = {
  output: pluginExport ? "export" : "standalone",
  basePath,
  turbopack: { root: process.cwd() },
  transpilePackages: ["three"],
};

export default nextConfig;
