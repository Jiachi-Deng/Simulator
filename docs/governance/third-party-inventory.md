# 第三方软件、品牌与来源清单

> 本文是工程与发行治理清单，不是法律意见。许可、服务条款、商标和平台政策可能变化；每次公开发行前应由项目负责人和具备资质的法律顾问复核最终制品及当时有效条款。

## 使用范围

本清单覆盖源码仓库、Electron 桌面安装包、server 发行物和容器镜像。表中的“是否分发”依据当前构建配置判断；`是` 表示进入至少一种发行制品，`间接` 表示通常经 bundle 或传递依赖进入，`否/工具` 表示仅用于构建或开发。最终结论必须以待发行制品的 SBOM、文件清单和许可证扫描结果为准。

## 发行前总控

- 为每个平台的最终制品生成 SBOM，并保留包名、版本、下载来源、校验和、许可证表达式及对应制品。
- 从 lockfile 和最终 bundle 生成第三方 notices；不能只引用 `package.json`，因为传递依赖和内嵌二进制不会完整显示在那里。
- 将根 `LICENSE`、根 `NOTICE`、第三方 notices 和必要的许可证全文放入源码发行包及可执行制品的可读位置。
- 对源码、应用资源、安装器、文档和网站执行一次名称、图标、域名及第三方 logo 扫描。
- 归档发行 commit、构建日志、SBOM、notices、下载校验和、人工例外审批和条款复核日期。

## 清单

| 项目 | 来源与当前证据 | 许可或条款 | 是否分发 | 主要风险 | 发行前动作 |
| --- | --- | --- | --- | --- | --- |
| 仓库 `LICENSE` / `NOTICE` | 根 `LICENSE` 声明 Craft Agents 为 `Apache-2.0`，Copyright 2026 Craft Docs Ltd.；根 `NOTICE` 包含 Craft attribution、Claude Agent SDK 条款链接及第三方依赖概述 | Apache License 2.0 第 4 节要求分发时保留许可证、相关 notice，并标示修改文件；第 6 节不授予商标权 | 是，源码和二进制发行均相关 | fork 若遗漏原始 `NOTICE`、修改声明或版权/专利/商标 notice，可能不满足再分发条件；当前 `NOTICE` 不能替代完整第三方 notices | 保留原始 `LICENSE`/`NOTICE`；给修改文件和衍生发行物保留清晰 provenance；在制品内验证 notices 可读；不要把新增 notice 写成修改原许可证条款 |
| Claude Agent SDK 与 native `claude` binary | 根 `package.json` 固定 `@anthropic-ai/claude-agent-sdk`；`apps/electron/electron-builder.yml` 通过 `extraResources` 携带 SDK 与平台 binary；`scripts/build-server.ts` 也组装平台包 | 当前根 `NOTICE` 指向 Anthropic Commercial Terms of Service；SDK/npm 包及 native binary 的具体许可、使用限制和品牌规则须按锁定版本及发行时条款核验 | 是 | 商业条款不是普通 OSS 许可证；SDK 与 native binary 可能适用不同文件或附加条款；版本升级可能改变权利、限制和 notice 要求 | 保存锁定版本对应的官方条款快照和包内许可文件；确认允许目标分发方式、地区和用途；核对 API/模型服务条款；在 notices 中准确署名且不暗示 Anthropic 背书 |
| Pi fork（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-agent-core`） | 根及 workspace manifests 使用 `@earendil-works/*` 版本 `0.80.6`；已安装 package metadata 初步声明 MIT，并指向 `https://github.com/earendil-works/pi.git` 及对应 package directory；`packages/pi-agent-server` 将其用于 Pi Agent 服务 | 当前已有来源与许可证的初步机器可读证据，但仓库尚未归档基准 commit、fork 修改链、许可证文件和完整 notice | 是或间接 | provenance 仍不完整：无法从当前仓库复现 fork 相对上游的修改范围，也未证明最终制品内容与 package metadata 完全一致 | 从 registry 和维护仓库验证 metadata；固定完整 commit；保存许可证文件、fork diff/patch 和修改声明；核验所有 `@earendil-works/*` 包及传递依赖；补充 NOTICE/SBOM 后再发行 |
| Electron / electron-builder / Chromium / Node.js | 根 manifest 使用 Electron 与 electron-builder；桌面应用由 `apps/electron/electron-builder.yml` 打包 | Electron 通常为 MIT，同时分发的 Chromium、Node.js、FFmpeg 等含多种第三方许可；electron-builder 及安装器工具也有各自许可。以实际版本附带文件为准 | Electron runtime 是；部分 builder 仅工具 | 只列 “Electron/MIT” 会漏掉 runtime 内大量 notices；codec、平台 installer 和可选组件可能带额外要求 | 从最终 Electron 目录收集 `LICENSE`、`LICENSES.chromium.html` 等文件；保留 Electron 版本；扫描 DMG/ZIP/NSIS/AppImage 等每种制品；区分 runtime 与仅构建工具 |
| Bun | 根项目以 Bun 安装/构建；`scripts/build-server.ts` 为 server 发行物下载并放入 `vendor/bun/bun`；Docker 镜像以 `oven/bun` 为基础 | Bun 本体及其内嵌组件适用各自许可证；容器基础镜像还包含系统软件许可。具体以锁定版本、官方发行包和镜像内容为准 | 是，至少 server 发行物和容器；桌面是否携带需按平台制品核验 | 下载二进制与源码依赖清单脱节；基础镜像与内嵌组件容易漏入 SBOM/notices | 固定版本、官方 URL 和 SHA-256；保存发行包内许可证；对 server 压缩包及镜像分别扫描；确认桌面 `resources/bin` 是否实际含 Bun |
| uv | `scripts/build-server.ts` 下载 uv 至 `resources/bin/uv`；Electron 资源/构建逻辑也按平台处理 uv | uv 及其所含第三方组件以对应锁定版本的官方许可文件为准 | 是，server；桌面按最终制品核验 | 构建期下载使 lockfile 无法证明来源和许可；不同平台二进制可能不同 | 固定版本、下载 URL、SHA-256 和许可证快照；逐平台检查制品；将 uv 及适用 notices 写入 SBOM/第三方 notices |
| ripgrep | 根依赖 `@vscode/ripgrep`；Electron 配置通过 `extraResources` 携带；server 构建和 Docker 镜像也安装或复制 `rg` | ripgrep 常见为 MIT 或 Unlicense 双许可；npm wrapper、预编译 binary 和系统包的元数据应分别核验 | 是 | wrapper 与 native binary 的版本/许可可能被错误合并；Docker apt 包来源与 npm binary 来源不同 | 记录每个制品中 `rg` 的来源、版本和 checksum；保留所选许可文本及 wrapper notice；避免在同一 SBOM 条目中混淆 apt 与 npm 来源 |
| Baileys / WhatsApp | `packages/messaging-whatsapp-worker` 使用 `@whiskeysockets/baileys`；`scripts/build-wa-worker.ts` 将 Baileys 及必需传递依赖内嵌进 `worker.cjs`；Electron/server 将 worker 纳入制品 | Baileys 及传递依赖适用各自 OSS 许可；“WhatsApp”名称、logo、服务访问和自动化行为另受 Meta/WhatsApp 商标、Business/服务条款及平台政策约束 | 是，内嵌 bundle | 单文件 bundle 隐藏依赖和 notice；非官方集成可能因协议或平台政策变化失效或受限；使用 WhatsApp 品牌可能造成隶属关系误解 | 从 worker 构建 metafile/lockfile 生成组件清单和 notices；复核 Baileys 当前许可与传递依赖；产品文案明确非官方关系；不随意使用 WhatsApp logo；由法律/产品确认目标用例符合当时平台条款 |
| npm/Bun workspace dependencies | 根及 `apps/*`、`packages/*` 的 `package.json`，解析版本以 `bun.lock` 为准；包含 production、optional、native、workspace 与 dev dependencies | 每个直接及传递包适用其自己的许可证；manifest 中的 `license` 字段只是初始证据，不等同于完成合规审查 | 是、间接或工具，取决于 bundle/打包结果 | copyleft、source-available、`UNLICENSED`、缺失许可证、双许可选择、native binary、字体/模型/数据文件和安装脚本常被普通扫描漏掉 | 对 lockfile 和最终制品做双重扫描；按 runtime/dev/optional 分类；人工处理未知或非 SPDX 条目；保存许可证全文；建立拒绝/审批规则；升级依赖后重新生成而非沿用旧报告 |
| Craft 商标、名称和图标 | 根 `TRADEMARK.md`；`apps/electron/electron-builder.yml`；`apps/electron/resources/`；`packages/shared/src/branding.ts` | Apache-2.0 不授予 Craft 商标权；`TRADEMARK.md` 要求 fork 更名、替换 Craft logo/icon、更新 bundle identifier，并移除非官方 Craft 域名引用；允许准确描述“基于/源自 Craft Agents” | 当前源码与资源中是；Simulator 发行不应继续作为产品品牌分发 | 代码许可不等于商标许可；应用名、图标、bundle ID、更新源、域名、版权信息和截图可能造成官方关联或背书误解 | Simulator 发行前完成全仓及制品扫描；替换产品名、图标、安装器资源、bundle ID、协议 scheme、更新源和域名；仅保留必要且准确的 provenance/attribution；疑义向权利方取得书面许可 |
| 第三方 logo、服务图标、品牌名 | `apps/electron/resources/tool-icons/`、UI source/provider 图标、README/docs/screenshots 及其他静态资源；具体权利链尚未在仓库集中登记 | logo 通常受商标、品牌指南和著作权约束，不因相关 SDK 为 OSS 而自动可用；各品牌规则分别适用 | 可能是 | 来源、作者、授权范围、是否允许改色/裁切/组合、是否允许随商业产品分发不清；图标可能暗示官方集成 | 建立逐文件资产台账：路径、品牌、来源 URL、下载日期、权利人、授权依据、允许的变体；删除无法证明授权的资产；对 nominative use 保持最小且配套非隶属声明 |
| 未来 Proma 代码迁移 provenance | Proma 当前采用 AGPL-3.0；任何迁移都必须在复制前逐文件确认来源、作者、commit、修改历史和与 Simulator 的组合方式 | Proma 代码受 AGPL-3.0 及其第三方依赖条款约束，不会因为复制到 Apache-2.0 仓库就转为 Apache-2.0；紧密组合可能要求整个 covered work 按 AGPL 提供 Corresponding Source | 仅在未来批准迁移后 | 直接 copy/squash 会模糊许可证边界，并可能让预期闭源分发的 Simulator 产生 AGPL 义务；重写相同功能也必须避免照抄受保护表达 | 默认优先依据行为和测试进行 clean-room 式重构；确需复制时先完成法律评估和架构边界决策，建立 `PROVENANCE.md`，记录 Proma 仓库 URL、完整 commit、文件映射、许可证、导入方式和对应 Simulator commit；未经批准不得迁移 Proma 实现代码 |

## 外部代码 provenance 最低记录格式

每次导入或同步至少记录：

| 字段 | 要求 |
| --- | --- |
| 上游 | 仓库 URL、项目名、权利人 |
| 基准 | tag、完整 commit SHA、获取日期 |
| 导入 | 导入 commit、执行人、方式（merge/subtree/patch/copy） |
| 修改 | patch 列表或可复现 diff、重命名映射、删除内容及原因 |
| 法务材料 | 上游 `LICENSE`、`NOTICE`、第三方 notices、商标政策的归档位置与版本日期 |
| 制品 | 对应发行版本、平台、SBOM、checksum、构建日志 |
| 例外 | 未解决项、风险接受人、截止日期和阻断条件 |

## 当前阻断项

在以下事项完成前，不应把本清单视为可发行的合规结论：

1. 未从最终桌面/server/容器制品生成并人工复核 SBOM 与第三方 notices。
2. Pi fork 尚缺可审计的上游、许可和修改 provenance。
3. Claude Agent SDK/native binary 的当前商业条款与再分发权限尚未形成版本化审查记录。
4. Craft 品牌资产和第三方 logo 尚未形成逐文件权利台账，Proma 重品牌尚未完成制品级验证。
5. Baileys bundle 的传递依赖 notices 及 WhatsApp 平台/品牌条款尚未完成发行时复核。
