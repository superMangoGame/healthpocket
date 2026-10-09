# HealthPocket · 健康口袋

**English summary.** HealthPocket is a local-first, desktop-only Obsidian plugin for organizing personal and family health-checkup PDF reports. It parses text-based PDFs on your machine, tracks lab metrics across years, and highlights findings on a Chinese-labeled 3D anatomy model (BodyParts3D, CC BY 4.0). The UI is in Simplified Chinese and the parsers target common Chinese checkup report templates. Optional features that use the network are off by default: AI insights (your chosen model provider, plus the public models.dev catalog for model lists) and an experimental Garmin sync that uses Garmin's unofficial mobile-app API. Health data is stored outside the vault in `~/.healthpocket/`. No ads, no telemetry. HealthPocket does not provide medical advice.

健康口袋是一个本地优先的 Obsidian 桌面插件，用于整理个人和家庭的体检报告。导入 PDF 后，可查看原文页码、指标趋势、按年份汇总的异常证据，以及中文标注的人体图谱。

当前版本为 **0.4.0**，已采用 Community Plugins 的三文件发布结构；尚未在官方市场上架。支持 Obsidian 桌面版，暂不支持移动端。

## 功能

- 家庭成员独立档案，支持单次选择最多 50 份 PDF、3 任务并发解析，并提供逐份进度、重复报告检测、重新解析、完整备份和删除。
- 爱康 2018–2020、美年 2021–2023、美年 2024–2025 报告模板的确定性解析规则。
- 年度指标趋势、原报告参考范围、异常与关注结论去重；低置信度结果不参与状态汇总。
- Human Atlas / BodyParts3D 的 2,234 个独立解剖结构、逐结构中文名称、15 个系统图层开关、拆解滑杆，以及与所选年份联动的器官异常高亮。
- 可选的 Garmin 同步（实验性，默认关闭）：在 Obsidian 设置 → HealthPocket 中开启后，可登录 Garmin 并手动同步睡眠、心率、压力、步数、HRV 和运动记录。
- 可选的 AI 洞察：设置页按“供应商、API Key、模型”三步配置，支持 DeepSeek、OpenAI、硅基流动、OpenRouter、Moonshot、阿里云百炼和本地 Ollama；AI 洞察页面可流式对话、展开供应商返回的思考内容，并附加 CSV、JSON、Markdown 或 TXT 数据。

本项目用于整理和回顾报告，不提供诊断、预测或个性化医疗建议。人体模型是成年男性参考体；女性特异器官使用导航示意标记。

## 安装和使用

发布前可使用手动安装包：解压 `healthpocket-0.4.0.zip`，将其中的 `healthpocket` 文件夹放到 vault 的 `.obsidian/plugins/` 下。在 Obsidian 设置中启用 HealthPocket，点击心电图图标或运行「HealthPocket: 打开主界面」命令。

**从 0.2.x 升级**：0.3.0 起插件 ID 由拼写错误的 `heathpocket` 更正为 `healthpocket`。请先在 Obsidian 中停用旧插件，删除 `.obsidian/plugins/heathpocket/` 文件夹，再安装新版并重新启用。两个版本不能同时启用，否则会因共用数据目录而报「已被另一个实例打开」。健康数据保存在 vault 之外（见下文），不受影响；已保存的 AI API Key 和 Garmin 令牌会在首次使用时自动迁移。旧版保存过的 Garmin 密码会在启动时被删除。

安装目录只需要：

```text
healthpocket/
  main.js
  manifest.json
  styles.css
```

安装插件后无需另外安装 Node.js、Python、pip 或原生 SQLite。网页、数据库运行库、PDF 解析器、Garmin 连接、开源 Vercel AI SDK、assistant-ui 和人体模型全部包含在 `main.js` 内。由于完整模型约 33 MB，运行文件较大；下载和首次启用会比小型插件慢。

导入支持可复制文字的 PDF，单次最多选择 50 份，系统以 3 个并发任务处理；单份不超过 80 MB、300 页。扫描型 PDF 需要预先生成可搜索文字层；本版本不包含 OCR。加密 PDF 不支持。未识别模板或可信字段不足时标记为「部分解析」，不会把不确定结果当成正常结论。

## 隐私、网络和文件访问

PDF 解析、SQLite 存储、风险汇总和人体模型加载均在本机完成。AI 洞察默认关闭；启用后，插件会连接用户选择的模型供应商。在设置页选择供应商时，插件还会请求公开的模型目录 `https://models.dev/api.json` 来补充可选模型列表（不发送任何健康数据或 API Key）。对话和生成洞察时会发送当前档案或所选范围内的结构化指标与报告结论；用户主动添加的数据附件也会随该次对话发送。原始 PDF 不会自动上传；发送前移除档案姓名，并尝试移除文本中的邮箱、手机号和身份证号。去标识不代表完全匿名，所选服务的费用、账号要求、数据保留和隐私政策由该服务提供方决定。

Garmin 同步是实验性功能，默认关闭，需要先在 Obsidian 设置 → 第三方插件 → HealthPocket 中开启；关闭时插件不会连接任何 Garmin 服务，AI 对话也不会读取 Garmin 数据。从旧版升级且已登录过 Garmin 的用户会自动保持开启。开启后，仅在用户登录并点击「手动同步」时联网。启用后，插件会连接 Garmin 的登录与数据服务（全球区 `sso.garmin.com`、`connectapi.garmin.com`，中国区 `sso.garmin.cn`、`connectapi.garmin.cn`），下载睡眠、心率、压力、步数、HRV 和运动记录等数据保存到本地；首次登录或同步时还会从 `thegarth.s3.amazonaws.com` 下载一份公开的 Garmin 应用凭据（不含账号信息，下载后保存在本地，之后不再请求）。**Garmin 没有面向个人开发者的公开 API，本插件模拟 Garmin Connect 手机 App 的登录与接口，不是 Garmin 官方产品，也未获 Garmin 授权或认可。** 这可能违反 Garmin 服务条款；Garmin 随时可能更改接口导致功能失效，也可能对频繁请求限流或限制账号。请自行评估后使用。

API Key 使用 Obsidian SecretStorage 保存，不写入 HealthPocket 数据库、网页存储、日志或导出备份。OpenAI 请求显式关闭服务端响应存储；其他兼容服务是否存储请求取决于其自身实现。插件不会在连接失败时自动切换到其他云服务。除用户主动测试连接或生成洞察外，不会向模型服务发送请求。本插件无广告或遥测。

界面通过绑定在 `127.0.0.1` 的本地 HTTP 服务展示：服务在首次打开健康口袋时才启动，首次使用随机端口，之后优先复用同一端口（被占用时改用新的随机端口），端口号保存在插件的 `data.json` 中。本地数据接口使用每次插件加载生成的随机令牌，并校验请求主机和来源。停用插件时关闭服务。不要转发本地界面地址或开放该端口到公网。

插件会访问 vault 外的本地文件，以持久保存 PDF 和数据库，避免插件升级时覆盖健康记录。默认目录：

```text
~/.healthpocket/
  healthpocket-ts.db       当前版本的 SQLite 数据库
  reports-ts/             当前版本管理的 PDF 副本
```

可在启动 Obsidian 前使用 `HEALTHPOCKET_DATA_DIR` 指定目录，或用 `HEALTHPOCKET_HOME` 更改默认根目录。同一目录只允许一个插件实例写入；多个 vault 同时启用时应指定不同数据目录或关闭重复实例。该目录不随 Obsidian Sync 自动同步。当前存储没有额外加密，请使用系统磁盘加密和合适的备份保护。

如果插件源码目录已有旧版 `healthpocket.db` 或 `data/reports/`，会从旧开发目录读取迁移来源。已有 `~/.healthpocket/healthpocket.db` 的用户也会自动迁移。升级时复制旧数据库和 PDF 到新运行目录，原文件保持原样；旧数据库若仍有活动事务，需先正常关闭旧 Python 服务再升级。

「删除全部」删除新运行库里的报告、指标、结论和解析任务，保留家庭档案。迁移前的旧数据库、旧 PDF 及用户已导出的备份不在删除范围；彻底清理时需自行处理这些原始副本。卸载插件也不会自动删除健康数据。退回旧版只能看到迁移时的旧数据，新版新增记录请先导出备份。

## 构建、测试和打包

### Garmin 登录与手动同步

Garmin 登录、双重验证、令牌交换及健康数据同步均由插件内的 TypeScript 实现，不需要安装 Python、pip、`garth` 或 `requests`。请求在本地插件进程中发送，以绕过浏览器跨域限制。中国区（garmin.cn）请求始终直连，不经过系统代理；只有在启动 Obsidian 前设置了 `HTTPS_PROXY`/`ALL_PROXY` 环境变量时才走该代理。全球区（garmin.com）支持 HTTP/HTTPS 代理环境变量、SOCKS5 代理环境变量，以及 macOS 和 Windows 的系统 HTTP/HTTPS 代理设置。不支持自动执行 PAC 脚本。

先在 Obsidian 设置 → HealthPocket 中开启「Garmin 同步（实验性）」，再在健康口袋的设置页选择实际的 Garmin 账号区域，输入邮箱和密码，点击「登录 Garmin」；需要两步验证时输入 Garmin 发来的验证码。登录只保存令牌，不查询账号资料或下载健康数据。之后点击「手动同步」下载数据；重启或打开页面不会自动同步。

Garmin 密码只用于本次登录：登录成功后即丢弃，不写入磁盘、SecretStorage、数据库、日志或导出备份；需要两步验证时，密码仅在等待验证码期间保存在内存中，以便「重新发送验证码」。令牌保存在 Obsidian SecretStorage 中。验证码会话在取消、重新登录、插件关闭或十分钟过期时结束。令牌失效后需要重新输入密码登录。

### 开发命令

开发需要 Node.js 22.19+，安装者不需要这些工具。

```sh
npm ci
npm ci --prefix web
npm run package
```

打包命令依次构建静态页面、内嵌运行文件、执行 TypeScript 检查与运行时回归、执行三文件独立启动测试，最后生成：

- `dist/main.js`、`dist/manifest.json`、`dist/styles.css`：GitHub Release 附件。
- `dist/SHA256SUMS.txt`：文件校验值。
- `healthpocket-0.4.0.zip`：给其他用户手动安装的压缩包。

发布文件使用白名单打包，不包含健康数据、原始 PDF、旧版 Python 服务、照片或开发环境；Garmin 登录、数据同步和依赖的网络实现均内嵌在 main.js 中。

其他开发命令：

```sh
npm run build            # 先构建页面，再生成 main.js
npm run build:obsidian   # 使用已有 lib/app，快速重新打包
npm test                 # 类型检查及运行时回归
npm run test:standalone  # 将三个文件复制到临时目录后启动测试
```

本地私有数据的只读回归可以设置 `HEALTHPOCKET_PRIVATE_DB` 后运行 `node scripts/private-regression.mjs`。仅输出汇总匹配数量，不输出个人报告内容，也不修改源数据库。

目录说明：`obsidian/` 为入口，`src/` 为 TypeScript 数据库、解析器、接口与静态服务，`web/` 为界面源码，`lib/app/` 为构建中间产物，`scripts/` 为构建、测试和模型生成脚本。早期的 Python 服务已从仓库移除（可在 Git 历史中查看）。

## 发布到社区市场

确认公开仓库仅包含需要公开的源码与模型授权文件。每次发布同步 `package.json`、`manifest.json`、`versions.json` 中的版本号。创建与 manifest 版本完全一致的 Git 标签，例如 `0.4.0`，不加 `v` 前缀。

`.github/workflows/marketplace-release.yml` 会测试、打包并创建带三个标准附件的 **草稿 Release**。核对后发布该 Release，再前往 [Obsidian Community](https://community.obsidian.md/) 登录、关联 GitHub 并提交插件。手动触发 workflow 只生成构建附件，不自动公开发布。

官方审核和上架由 Obsidian 决定。参考 [提交插件](https://docs.obsidian.md/plugins/releasing/submit-plugin) 与 [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)。

## 许可与署名

HealthPocket 代码采用 [MIT License](LICENSE)。Human Atlas 的原始应用代码由其作者提供，采用 MIT；人体模型是 BodyParts3D 4.0 数据的浏览器优化版本，采用 CC BY 4.0。模型保留全部结构并增加中文名称。完整来源、作者及修改说明见 [Human Atlas 署名](web/public/licenses/HUMAN_ATLAS_ATTRIBUTION.md) 和 [Human Atlas 代码许可](web/public/licenses/HUMAN_ATLAS_LICENSE.txt)。

PDF.js（Mozilla，Apache-2.0）、sql.js（MIT）、fflate（MIT）及界面依赖保留各自许可；构建时将许可文本内嵌到应用，用户可在设置页查看。
