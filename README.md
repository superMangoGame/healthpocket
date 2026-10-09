<div align="center">

# 健康口袋 HealthPocket

**本地优先的 Obsidian 体检报告管理插件**

把历年体检 PDF 拖进来，看指标趋势、异常结论和 3D 人体图谱。数据只存在你自己的电脑上。

[![Release](https://img.shields.io/github/v/release/superMangoGame/healthpocket?label=release)](https://github.com/superMangoGame/healthpocket/releases/latest)
[![CI](https://github.com/superMangoGame/healthpocket/actions/workflows/ci.yml/badge.svg)](https://github.com/superMangoGame/healthpocket/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Obsidian Desktop](https://img.shields.io/badge/Obsidian-desktop%20only-7c3aed)

<!-- 演示视频：在 GitHub 网页编辑本文件，把 docs/demo-720p.mp4 拖到这一行，替换成生成的 https://github.com/user-attachments/assets/... 链接 -->
DEMO_VIDEO_URL

[English](#english) · [安装](#安装) · [功能](#功能) · [开发](#开发) · [隐私](#隐私)

</div>

## 功能

- 📄 **批量导入体检 PDF**：一次最多 50 份，本机解析。支持爱康、美年等常见模板，其他机构走通用解析。
- 📈 **指标趋势**：血压、血常规、血脂等指标按年份画成曲线，每个数字都能追溯到原报告页码。
- 🫀 **3D 人体图谱**：基于 BodyParts3D 的 2,234 个中文标注结构，异常器官直接在身上标红。
- 👨‍👩‍👧 **家庭档案**：每个家庭成员独立管理。
- 🤖 **AI 洞察（可选，默认关闭）**：可接 DeepSeek、OpenAI、硅基流动、OpenRouter、Moonshot、阿里云百炼或本地 Ollama。发送前会去掉姓名、手机号等个人标识。
- ⌚ **Garmin 同步（实验性，默认关闭）**：同步睡眠、心率、HRV、压力、步数和运动记录。

> [!NOTE]
> 本项目只用于整理和回顾报告，不提供诊断或医疗建议。目前只支持桌面版 Obsidian，扫描件 PDF 需要先做文字识别（OCR）。

## 安装

1. 从 [Releases](https://github.com/superMangoGame/healthpocket/releases/latest) 下载 `healthpocket-x.y.z.zip`。
2. 解压，把 `healthpocket` 文件夹放进 vault 的 `.obsidian/plugins/` 目录。
3. 在 Obsidian **设置 → 第三方插件** 中启用 HealthPocket。
4. 点击左侧的心电图图标，或运行命令「HealthPocket: 打开主界面」。

不需要另外安装 Node.js、Python 或 SQLite，所有依赖都打包在 `main.js` 里。人体模型较大，所以 `main.js` 约 50 MB。

## 开发

需要 Node.js 22.19+。建议直接把仓库克隆到一个测试 vault 的插件目录，改完代码在 Obsidian 里重新加载即可。

```sh
cd <你的测试 vault>/.obsidian/plugins
git clone https://github.com/superMangoGame/healthpocket.git healthpocket
cd healthpocket
npm ci && npm ci --prefix web
npm run build              # 构建界面（web/ → lib/app）并生成 main.js
```

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 完整构建：界面 + 插件 |
| `npm run build:obsidian` | 只改了 `src/` 或 `obsidian/` 时用，复用已构建的界面，速度快 |
| `npm test` | 类型检查和运行时回归测试 |
| `npm run test:standalone` | 只用三个发布文件启动插件做冒烟测试 |
| `npm run package` | 构建、测试并打包到 `dist/` 和 `healthpocket-x.y.z.zip` |
| `npm run release` | 把打包产物发布为 GitHub Release（需要 `GITHUB_TOKEN`） |
| `node scripts/garmin-diagnose.mjs` | 诊断 Garmin 登录链路，加 `--live` 用真实账号测试 |

**调试技巧**

- 重新构建后，在 Obsidian 中关闭再开启插件，或按 `Cmd/Ctrl + R` 重新加载。
- 按 `Cmd + Option + I`（Windows 为 `Ctrl + Shift + I`）打开开发者工具，查看日志和网络请求。
- 用 `HEALTHPOCKET_DATA_DIR=/tmp/hp-dev` 启动 Obsidian，可以让开发数据和真实数据分开。

**目录结构**

```text
obsidian/   插件入口、设置页、更新检查
src/        本地服务：PDF 解析、SQLite、接口、Garmin、AI
web/        界面（Next.js 静态导出，内嵌到 main.js）
scripts/    构建、测试、打包和发布脚本
tests/      运行时回归测试
```

## 隐私

- **全部在本机处理**：PDF 解析、数据库和人体模型都在本地运行，没有广告和遥测。
- **数据目录**：`~/.healthpocket/`，放在 vault 之外，不会被 Obsidian Sync 同步，卸载插件也不会删除。可以用 `HEALTHPOCKET_DATA_DIR` 换成别的目录。
- **会联网的情况**：只有你主动启用 AI 洞察或 Garmin 同步之后才会联网。API Key 和 Garmin 令牌保存在 Obsidian SecretStorage 中，Garmin 密码登录后立即丢弃。
- **本地服务**：界面通过只绑定 `127.0.0.1` 的本地服务展示，每次加载插件都会生成随机访问令牌。

> [!WARNING]
> Garmin 没有面向个人的公开 API。本插件模拟 Garmin Connect 手机 App 的接口，不是官方产品，可能违反 Garmin 服务条款，也可能随时失效。请自行评估后使用。

## English

HealthPocket is a local-first, desktop-only Obsidian plugin for organizing health-checkup PDF reports. It parses text-based PDFs on your machine, tracks lab metrics across years, and highlights findings on a Chinese-labeled 3D anatomy model. The UI is in Simplified Chinese, and the parsers target common Chinese checkup report templates. AI insights and Garmin sync are optional and off by default. No ads, no telemetry, and no medical advice.

## 许可

代码采用 [MIT License](LICENSE)。人体模型来自 BodyParts3D 4.0（CC BY 4.0），经 Human Atlas 优化并加上中文名称，详见 [署名说明](web/public/licenses/HUMAN_ATLAS_ATTRIBUTION.md)。PDF.js、sql.js、fflate 等依赖保留各自的许可证。
