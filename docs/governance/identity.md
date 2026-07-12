# Simulator canonical identity map

本文定义 Simulator 的 canonical identity，作为后续品牌替换、发布配置、协议注册、数据迁移和 package 重命名的统一依据。本文是治理决策草案，不代表所有建议值已经在源码或外部平台落地。

## Canonical map

| 身份面 | Canonical 值 | 状态 | 说明 |
| --- | --- | --- | --- |
| 产品名 | `Simulator` | Confirmed | 用户指定的产品名称；UI、安装包名称、日志与文档应统一使用。 |
| GitHub 仓库 | `Jiachi-Deng/Simulator` | Confirmed | 用户指定的 canonical repository；源码中的 issue、release、update 与贡献链接最终应指向该仓库。 |
| macOS / Electron Bundle ID | `io.github.jiachideng.simulator` | Proposed | 建议值，符合 reverse-DNS 形式；替换当前 `com.lukilabs.craft-agent` 前必须确认签名、更新与系统权限影响。 |
| deep link scheme | `simulator://` | Proposed | 面向用户与外部集成的新 canonical scheme；迁移期兼容 `craftagents://`。 |
| 用户数据目录 | `~/.simulator` | Proposed | 新安装的 canonical 数据根目录；迁移期兼容当前 `~/.craft-agent`。 |
| 环境变量前缀 | `SIMULATOR_` | Proposed | 新增变量统一使用此前缀；迁移期读取对应的 `CRAFT_` 旧变量。 |
| npm scope | `@simulator/*` | Proposed | 内部 package 的目标 scope；发布前必须确认 npm 组织名所有权与可用性。 |
| GitHub Pages URL | `Pending` | Pending | 需确认是否启用 Pages、发布源与最终 URL。若使用默认 project site，候选值为 `https://jiachi-deng.github.io/Simulator/`，但不得在确认前视为 canonical。 |
| 产品域名 | `Pending` | Pending | 需由所有者确认注册与控制权、HTTPS、redirect 和长期维护主体。 |
| 文档站点 | `Pending` | Pending | 需确认使用 GitHub Pages、产品域名子路径或独立 docs 域名。 |
| update / release feed | `Pending` | Pending | 需确认 release 托管、签名、公钥轮换及 auto-update feed。 |
| 安全邮箱 | `Pending` | Pending | 必须是项目所有者可持续接收并响应的地址；不得继续把上游 `security@craft.do` 当作 Simulator 联系方式。 |
| 法务 / trademark 联系方式 | `Pending` | Pending | 需确认责任主体和有效联系方式。 |
| 代码签名主体 | `Pending` | Pending | 需确认 Apple Developer Team、Developer ID、Windows signing certificate 及 Linux 发布主体。 |
| npm publisher / organization | `Pending` | Pending | `@simulator/*` 能否发布取决于 scope 所有权与发布权限。 |

## 源码基线

当前源码仍保留上游 Craft Agents identity，主要包括：

- Electron `appId` 为 `com.lukilabs.craft-agent`，应用名与 package metadata 使用 `Craft Agents` / `Craft Docs Ltd.`。
- deep link 使用 `craftagents://`，并由 `CRAFT_DEEPLINK_SCHEME` 提供开发期覆盖。
- 持久化数据、日志、workspace、主题和配置主要位于 `~/.craft-agent`。
- 运行时和 feature flag 广泛使用 `CRAFT_` 环境变量前缀。
- monorepo package 广泛使用 `@craft-agent/*`。
- `SECURITY.md` 与其他 metadata 仍指向 `craft.do` 域名及其邮箱。

因此，任何品牌完成度审查都应以全仓搜索和运行时验证为准，不能只修改可见 UI 文案。

## 必须由用户确认的值

以下值涉及外部所有权、不可逆发布身份或系统信任关系，不能仅凭源码决定：

1. `io.github.jiachideng.simulator` 是否作为正式 Bundle ID，以及对应 Apple Developer Team、entitlements、notarization 和 update signing 配置。
2. `@simulator/*` scope 是否已注册并由正确的 npm organization 控制；若不可用，需要选定永久替代 scope。
3. GitHub Pages 是否启用、是否绑定 custom domain，以及 canonical URL、redirect 与 analytics 策略。
4. 产品域名、文档域名、安全邮箱、法务邮箱及其实际控制人和响应流程。
5. release/update feed、制品签名主体和已有用户升级路径。Bundle ID 或签名主体变化可能使系统把 Simulator 识别为另一款应用。

在上述值确认前，配置、文档和 UI 中应使用 `Pending` 或明确的开发占位值，不应发布看似正式但无人控制的 URL、邮箱或 package 名。

## 迁移兼容策略

迁移应按“先兼容、再切换、后清理”执行，并为每一阶段保留回滚路径。

### 1. 建立统一 identity 层

将产品名、Bundle ID、scheme、数据根目录、环境变量映射、repository URL 和 package scope 集中到少量配置入口。禁止继续在业务代码中新增 `craftagents`、`.craft-agent`、`CRAFT_` 或 `@craft-agent` 字面量。

### 2. 数据目录双读单写

- 首次启动优先读取 `~/.simulator`；若不存在且检测到 `~/.craft-agent`，执行可记录、可重试的迁移。
- 迁移采用 copy + validate + atomic switch，不直接删除旧目录；成功后写入 migration marker。
- 新版本只写 `~/.simulator`，但在至少一个稳定迁移周期内保留旧目录回退读取能力。
- credentials、OAuth token、workspace path、绝对路径引用和文件权限必须单独验证；不得把未加密 secret 写入迁移日志。
- 清理 `~/.craft-agent` 必须由用户显式触发，且应先提供备份与恢复说明。

### 3. deep link 双注册

- 新链接统一生成 `simulator://`。
- 迁移期同时注册并解析 `simulator://` 与 `craftagents://`，二者进入同一规范化 router。
- OAuth callback、桌面快捷方式、通知、自动化和外部文档中的旧链接需纳入兼容测试。
- 只有在已发布版本、文档和外部集成完成迁移并经过弃用期后，才移除 `craftagents://`。

### 4. 环境变量新优先、旧回退

每个变量采用 `SIMULATOR_X` 优先、`CRAFT_X` 回退的读取顺序；两者同时存在且值不同时，使用新变量并输出一次不含 secret 的 deprecation warning。子进程边界在迁移期可同时注入新旧变量，外部接口文档只展示 `SIMULATOR_`。移除旧变量前需统计 CI、开发脚本、部署配置和用户配置的剩余使用量。

### 5. npm scope 分阶段迁移

- 先确认 `@simulator` scope 所有权，再建立旧 package 到新 package 的完整映射。
- monorepo 内部可先用 workspace alias 或 export compatibility layer，避免一次性破坏所有 import、plugin 与 lockfile。
- 若 package 已对外发布，旧 `@craft-agent/*` 版本应发布明确的 deprecation notice，并在可行时提供 forwarding package；不得复用上游无控制权的发布身份。
- package rename 后验证 CLI binary 名、dynamic import、bundler external、plugin manifest、文档示例和第三方集成。

### 6. Bundle ID 与发布身份

Bundle ID 变更应视为独立 release migration：验证 Keychain access group、通知权限、deep link 注册、登录项、auto-update、应用数据路径、macOS quarantine/notarization 和卸载行为。若无法维持原应用升级链，应明确按“新应用安装 + 数据导入”发布，而不是承诺原位升级。

## 完成标准

identity 迁移只有在以下条件同时满足时才算完成：

- 全仓生产代码、构建配置、安装包 metadata、用户文档和 release pipeline 均使用已确认的 canonical 值。
- 所有 `Pending` 外部身份已由所有者确认并验证控制权。
- 旧 identity 仅存在于迁移代码、兼容测试、历史记录或 attribution/trademark 要求中，并有明确移除条件。
- 已验证新安装、旧数据升级、降级/回滚、deep link、OAuth、auto-update、package consumption 与各平台签名流程。
- 安全披露渠道真实可用，并由明确责任人定期监控。
