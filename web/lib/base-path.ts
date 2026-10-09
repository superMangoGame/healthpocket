/**
 * 构建期注入的基础路径（Obsidian 插件模式下为 /heathpocket/app，其余为空）。
 * 用于拼接 public/ 下静态资源的绝对 URL（Next 的 basePath 不覆盖
 * 手写字符串路径，如 Three.js 模型的 useGLTF 地址）。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
