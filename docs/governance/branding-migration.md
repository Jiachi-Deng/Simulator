# Craft -> Simulator 去品牌迁移

## 目标与原则

本文基于当前源码中的品牌标识建立迁移清单。目标是让对外产品统一为 **Simulator**，同时避免因一次性替换持久化路径、协议、环境变量或 package scope 造成用户数据丢失、自动化失效和旧链接不可用。

迁移遵循以下原则：

1. 用户可见品牌可立即替换；属于运行时契约的标识必须兼容迁移。
2. 新值优先、旧值回退；写入只使用新值，读取在迁移窗口内同时支持新旧值。
3. 不继续使用 Craft 商标、图标和服务域名来暗示官方关联。
4. Apache-2.0 许可、原始版权和上游来源不属于产品品牌，应依法保留。
5. Simulator 的域名、发布签名、OAuth 应用和联系人未就绪前，不用占位生产值替换可工作的旧端点。

## 迁移矩阵

### 立即替换

这些项目不承担向后兼容职责，可在第一阶段直接改为 Simulator。

| 类别 | 当前值 / 证据 | 目标 | 动作与验收 |
| --- | --- | --- | --- |
| 产品名 | `Craft Agents`；`apps/electron/electron-builder.yml`、`apps/electron/src/main/index.ts` | `Simulator` | 替换 `productName`、`app.setName`、安装包标题、菜单、通知、窗口标题及本地化文案。打包产物中不得出现用户可见的 Craft 产品名。 |
| 安装包文件名 | `Craft-Agents-${arch}.*`；`apps/electron/electron-builder.yml` | `Simulator-${arch}.*` | 修改 macOS、Windows、Linux artifact name 和 DMG volume title。 |
| package 描述与仓库元数据 | 根 `package.json` 的 `craft-agent`、Craft 文档描述；各 workspace 的 homepage | Simulator 描述与自有仓库地址 | 先改私有根包的名称/描述及不参与发布的 metadata；公开 package scope 另见兼容迁移。 |
| 应用图标与安装视觉 | `apps/electron/resources/icon.*`、`icon.icon/`、`craft-logos/`、`dmg-background*` | Simulator 资产 | 替换 app、DMG、Windows installer、Linux 图标和 OAuth callback 页 ASCII logo；检查浅色/深色、16px 至 1024px、macOS Assets.car。不得继续分发 Craft logo。 |
| 应用内文案 | 菜单、设置、OAuth 成功页、错误消息、macOS Local Network 描述中的 `Craft Agents` | `Simulator` | 仅替换用户可见文案，不机械改内部 symbol。运行 i18n parity/coverage 门。 |
| README 与产品文档 | 根 `README.md`、`apps/electron/README.md`、在线文档、截图、示例命令 | Simulator 使用说明 | 首页先声明 Simulator；历史来源放 attribution 小节。示例中的 CLI、路径、env、deep link 必须与对应兼容阶段一致。 |

### 需兼容迁移

这些标识已进入依赖图、用户脚本、OS 注册或磁盘数据。建议至少跨两个稳定版本保留兼容；移除旧入口前应有使用量证据或明确公告。

| 类别 | 当前值 / 证据 | 建议目标 | 兼容策略 | 退出条件 |
| --- | --- | --- | --- | --- |
| npm package scope | `@craft-agent/core`、`shared`、`server-core`、`server`、`ui`、`cli`、`viewer`、`session-tools-core`、`session-mcp-server`、`pi-agent-server`、messaging packages 等 workspace `package.json` 及全仓 import | `@simulator/*`（最终 scope 待 registry 确认） | 内部一次性更新 workspace package 名、imports、lockfile 和构建脚本；若已有外部消费者，在旧 scope 发布 re-export/deprecation shim，并锁定跨 scope 版本映射。不要用文本替换改第三方 attribution。 | 新 scope 可发布且安装测试通过；旧 scope deprecation 已公告；外部依赖窗口结束。 |
| CLI | 旧版自更新 CLI 使用 `craft`，安装到 `~/.local/share/craft/versions` 并建立 `craft` symlink；另有 `@craft-agent/cli` | `simulator` | 新二进制为 `simulator`；迁移期保留 `craft` wrapper，输出弃用提示后转发。CLI 参数和 exit code 不变。shell completion、README、安装/卸载脚本同时覆盖。 | 两个稳定版本；遥测或支持反馈表明旧命令可移除；提供手动卸载旧 symlink 指引。 |
| Bundle ID / 应用身份 | `com.lukilabs.craft-agent`；`apps/electron/electron-builder.yml` | Simulator 所有者批准的反向域名，如 `com.<owner>.simulator` | Bundle ID 变更会形成新的 OS 应用身份，不能假装原位升级。迁移器从旧 app data/keychain 导入；签名、notarization、通知、权限提示、单实例锁和卸载流程分别验证。 | 新签名与发布主体可用；旧版到新版迁移演练通过；可回滚且不覆盖旧数据。 |
| deep link | `craftagents://`；注册、解析与生成散布在 `apps/electron/src/main/index.ts`、`deep-link.ts`、`browser-pane-manager.ts`、server handlers | `simulator://` | 新版本同时注册并解析两个 scheme；内部只生成 `simulator://`。OAuth 回调、WebUI 与外部链接在窗口期继续接受旧 scheme。解析逻辑应参数化，不能只改入口常量而遗留 `parsed.protocol` 硬编码。 | 全路由契约测试覆盖新旧 scheme；外部页面已切换；旧链接窗口结束。 |
| 数据目录 | `~/.craft-agent`（config、workspaces、sessions、logs、credentials、permissions 等）；CLI 另有 `~/.local/share/craft` | `~/.simulator`、`~/.local/share/simulator` | 首次启动执行可重入迁移：新目录不存在时复制或原子移动；冲突时不覆盖，记录清单并提示。读取新目录优先、旧目录回退；凭据需通过原 secure-storage/keychain 方式迁移，禁止明文落盘。保留备份与迁移版本标记。 | 空目录、真实大目录、部分迁移、磁盘满、权限失败、重复启动和降级回滚测试通过。 |
| 环境变量 | 广泛使用 `CRAFT_*`，包括 `CRAFT_CONFIG_DIR`、`CRAFT_SERVER_URL/TOKEN`、RPC/TLS、runtime、WebUI、MCP、feature flags 等 | `SIMULATOR_*` | 建立集中 resolver：`SIMULATOR_*` 优先，`CRAFT_*` 回退并发出一次弃用告警；子进程迁移期同时注入两组关键变量。不得逐文件分散实现优先级。日志中继续遮蔽 token/secret。 | 自动生成完整变量表；冲突优先级、仅旧值、仅新值、secret redaction、子进程继承测试通过。 |
| 内部 metadata / tool 名 | `_displayName`、`_intent`，以及可能持久化或被模型引用的 `mcp__craft__*` | 品牌中性 metadata；`mcp__simulator__*` | `_displayName`、`_intent` 本身不是用户品牌，可暂保协议稳定；MCP tool namespace 若改变，应同时接受旧名并在导入的 session/transcript 中做 alias，不修改历史消息原文。 | 旧 session 回放、MCP schema 注入、tool-call repair 与多 provider 测试通过。 |

### 历史 attribution 保留

下列内容不能作为“去品牌”批量删除。

| 类别 | 保留内容 | 处理方式 |
| --- | --- | --- |
| 许可证与版权 | 根 `LICENSE`、`NOTICE`、上游版权声明 | 保留原文；新增 Simulator 自有变更的版权行时，不覆盖 Craft Docs Ltd. 的既有版权。 |
| 上游来源 | README 中“基于 / fork 自 Craft Agents”的事实说明 | 使用中性 attribution，不使用 Craft logo，也不暗示 Craft Docs Ltd. 认可或维护 Simulator。 |
| 商标政策 | `TRADEMARK.md` 中 Craft 商标归属和 fork 约束 | 保留为上游政策与迁移依据；可增加 Simulator 商标政策，但不可重写历史归属。 |
| 历史记录 | release notes、changelog、git 历史、旧 issue/PR 链接、历史测试 fixture | 原样保留事实；仅在仍作为当前操作指引的历史文档旁增加“旧名称/旧入口”说明。禁止重写 git 历史。 |
| 第三方名称 | `@anthropic-ai/*`、Craft 官方服务连接器或兼容说明 | 仅当确实连接该第三方时保留准确名称；不要把第三方 package 名误改为 Simulator。 |

### 待外部基础设施就绪

这些值必须由可验证的生产资源承接。就绪前可在开发环境通过配置覆盖，但不得发布虚构或失效的生产端点。

| 类别 | 当前值 / 证据 | 所需前置条件 | 切换要求 |
| --- | --- | --- | --- |
| update endpoint | `https://agents.craft.do/electron/latest`；electron-builder publish 与 `auto-update.ts` | Simulator HTTPS 域名、对象存储/CDN、各平台签名、manifest 与 rollout/rollback 机制 | 新旧版本升级链路实测；校验签名和 hash；404、损坏 manifest、断网不影响启动；旧 Craft endpoint 不再承载 Simulator 发布。 |
| OAuth URL | relay callback `https://agents.craft.do/auth/callback`，见 `packages/shared/src/auth/oauth-relay.ts`；provider redirect allowlist | 自有 OAuth app/client、Simulator callback 域名、provider 审核和 secret 管理 | 所有 provider 分别验证 desktop、WebUI、取消、state/PKCE、防重放；回调在 deep-link 双 scheme 窗口内兼容。不要在源码提交 client secret。 |
| share/viewer URL | `VIEWER_URL = https://agents.craft.do`，见 `packages/shared/src/branding.ts`；viewer dev proxy 同域 | Simulator viewer API、鉴权、存储、删除/撤销、隐私与 abuse 流程 | create/open/revoke、过期链接、权限边界、旧分享链接策略验证。旧链接是继续只读还是明确失效，需产品与法务决策。 |
| MCP / docs URL | `https://agents.craft.do/docs/mcp`、`/docs`，见 session MCP 与 doc-links/menu | Simulator docs 部署、MCP discovery/transport、稳定版本化 URL | MCP 初始化、schema、auth、超时、离线 fallback 与文档链接检测通过。若该 URL 指向 Craft 官方服务，只能作为明确标注的第三方连接保留。 |
| security/support/legal | `security@craft.do`、`legal@craft.do`，见 `SECURITY.md`、`TRADEMARK.md`；support 入口需全仓盘点 | Simulator 可值守邮箱或工单系统、SLA、漏洞披露流程、隐私/服务条款与商标主体 | 发布前替换当前产品的联系入口；Craft 联系方式仅保留在历史 attribution 或联系上游的上下文。发送测试邮件/工单并确认路由、自动回复和责任人。 |
| 域名与仓库链接 | `agents.craft.do` 及 `lukilabs/craft-agents-oss` issue/源码链接 | Simulator 官网、docs、status、源码仓库及重定向政策 | 用链接检查器验证生产链接；历史 commit/issue 引用继续指向上游，不伪造迁移后的对应关系。 |

## 阶段计划与测试门

### 阶段 0：冻结契约与盘点

- 确认 Simulator 法律主体、Bundle ID、package scope、域名、签名证书、发布仓库和联系人。
- 生成并评审品牌清单：`rg -i 'craft|lukilabs|agents\.craft\.do|@craft-agent|CRAFT_'`，按用户可见、兼容契约、attribution、第三方连接分类。
- 对现有 `~/.craft-agent` 和 CLI 安装结构制作脱敏样本；记录旧版支持的 deep-link 路由与 env 列表。

**测试门 G0：** 每个命中项都有 owner、分类和目标值；所有外部资源有负责人及就绪判据；迁移、回滚和数据保留策略通过评审。

### 阶段 1：视觉与文档去品牌

- 替换产品名、图标、安装视觉、当前 README 与 UI 文案。
- 保留许可证、NOTICE、历史 release notes 和中性上游 attribution。
- 引入集中 branding/config 常量，减少后续 URL 与名称散落。

**测试门 G1：** `bun run lint:i18n:parity`、`bun run lint:i18n:sorted`、`bun run lint:i18n:coverage` 通过；macOS/Windows/Linux 打包资源抽查通过；当前 UI、安装器和 OAuth callback 页面无 Craft logo 或误导性产品名；attribution 文件仍完整。

### 阶段 2：双栈兼容

- 上线 `SIMULATOR_*` 新优先、`CRAFT_*` 回退的集中 resolver。
- 同时处理 `simulator://` 与 `craftagents://`；内部生成新 scheme。
- 实施数据目录、凭据和 CLI 的可重入迁移；package scope 通过 alias/shim 过渡。

**测试门 G2：** 单元测试覆盖新值、旧值、冲突值和弃用告警；旧版真实数据副本升级后 workspace/session/config/credential 均可用；重复迁移无副作用；旧 deep link 和脚本仍工作；`bun run typecheck:all`、相关 config/storage/deep-link/CLI/MCP 测试通过。

### 阶段 3：外部服务切换与发布候选

- 切换 update、OAuth、share/viewer、docs/MCP、support/security/legal 到已验证的 Simulator 基础设施。
- 使用新的签名身份构建 release candidate；完成旧版到新版、跨平台、离线和失败回滚演练。

**测试门 G3：** `bun run validate:ci` 通过；签名/notarization/installer smoke test 通过；自动更新从最后一个 Craft 品牌版本升级成功；OAuth 全 provider、分享撤销、MCP、文档链接和联系人端到端验证通过；日志与发布物不泄露 secret。

### 阶段 4：弃用与清理

- 依据公告窗口和使用证据移除旧 CLI alias、旧 env fallback、旧 deep-link 注册及旧目录读取。
- 不删除历史 attribution、旧 release notes 或必要的数据迁移代码；迁移代码的保留期限应覆盖最低支持升级版本。

**测试门 G4：** 支持矩阵明确最低可升级版本；旧入口移除有 release note；全仓扫描剩余 `Craft` 命中仅属于 attribution、历史记录、兼容 fixture 或明确的 Craft 第三方服务；干净安装、受支持升级、卸载重装和降级行为均有记录。

## 发布阻断项

出现以下任一情况不得发布 Simulator 品牌构建：

- 新 Bundle ID 已启用，但没有旧数据与凭据迁移或回滚路径。
- 使用 Simulator 名称发布，却仍默认请求 Craft 的 update、OAuth、share 或 MCP 后端，且未明确获得授权并向用户披露。
- `security@craft.do` 或 `legal@craft.do` 仍被写成 Simulator 的产品联系人。
- Craft logo 仍出现在 app icon、installer、DMG、OAuth callback 或当前 README 主视觉中。
- 旧 env、deep link、CLI 或数据目录在无兼容窗口和无公告的情况下被直接删除。
- LICENSE、NOTICE、上游版权或来源 attribution 被删除或改写。
