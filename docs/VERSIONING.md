# Simulator Versioning Policy

本文定义 Simulator Host App 和正式 Release 的版本契约。支持窗口另见 [SUPPORT.md](../SUPPORT.md)，具体发布操作见 [RELEASE_OPERATIONS.md](RELEASE_OPERATIONS.md)。

## 版本事实源

根目录 `package.json` 的 `version` 是 Host App 构建的版本事实源。`bun run check-version` 当前要求根目录及 `apps/*`、`packages/*` 下的 package manifest 与它一致；测试 fixture 和明确排除的文档应用不共享 Host 版本。仓库中的 `packages/module-*` 是 Host 实现 package，因此仍跟随 Host 版本。

修改版本必须形成独立、可审查的 commit（可以位于对应 Release Milestone PR 内），并连同 `CHANGELOG.md` 和 Release notes 一起 Review。构建脚本、CI input、tag 或文件名不得覆盖 manifest 中的 Host product version。

## Semantic Versioning

Simulator 使用 `MAJOR.MINOR.PATCH`：

- `MAJOR`：稳定版本中的不兼容 API、数据或用户工作流变化；
- `MINOR`：向后兼容的功能，或 `0.x` 阶段明确记录迁移方式的不兼容变化；
- `PATCH`：向后兼容的 Bug、安全或打包修复；
- `-rc.N`：不可变的 Release Candidate，`N` 是从 1 开始的正整数。

稳定版发布前，`0.x` 不等于可以静默破坏用户数据。任何不兼容变化仍必须写入 CHANGELOG、提供迁移或回滚说明，并通过 ADR 记录长期兼容性决定。

## Release Candidate

Engineering RC 使用两项不得混淆的版本事实：

- **Host product version `X.Y.Z`**：写入所有 workspace manifest、`bun.lock`、App 的 `CFBundleShortVersionString` / `CFBundleVersion`、DMG/ZIP 内部版本、SBOM 和版本化 Release notes；
- **RC label `X.Y.Z-rc.N`**：只作为一次不可变工程候选的 workflow input、上传 artifact 名称和 bundle metadata 字段，不写回 package manifest，也不伪装成 macOS bundle version。

RC label 必须使用 `X.Y.Z-rc.N`，且其 `X.Y.Z` 必须与 Host product version 完全一致，并满足以下条件：

- source commit 必须等于受保护的 `origin/main` tip；当前 Engineering RC 不接受 release branch，未来如需支持必须先单独修改并 Review workflow、validator 和本文；
- manifest、DMG/ZIP 内部版本、Checksum、SBOM、Provenance 和 Release notes 使用同一 Host product version 与 commit；bundle metadata 同时记录 `rcLabel` 和 `productVersion`；
- 同一版本/tag/artifact 名称不得覆盖或重新上传不同 bytes；
- 新修复产生新的 commit 和新的 `rc.N`；同一基础版本的后续候选应递增 `N`，当前自动 gate 会拒绝 `rc.0` 和已存在的同名 tag，但维护者仍需在 Release evidence 中核对未创建 tag 的历史 Engineering RC；
- unsigned Engineering RC 必须明确标记 unsigned，并保持 production updater disabled。

当前 workflow 只生成工程验证 artifact，不会自动创建 tag、GitHub Release、Module prerelease 或修改稳定 official channel。正式发布仍受签名、公证、托管、OpenDesign 独立发布审批和 Go/No-Go 决策约束。

## Tags 与 Release

候选 tag 使用 `vX.Y.Z-rc.N`，稳定 tag 使用 `vX.Y.Z`。tag 必须指向已经完成 Required CI 的 commit，并且创建后不可移动。GitHub Release、更新 metadata 和公开下载必须引用已经验证的同一 artifact digest。

版本提交、tag、签名、上传和 update-feed activation 是不同权限边界。任何一步失败都不得通过替换同名 artifact 掩盖。

## Module 版本

通过 catalog 分发和安装的 Module artifact 拥有独立 SemVer，不跟随 Host App 强制同步；这与仓库中跟随 Host 版本的 `packages/module-*` 实现 package 是两个不同边界。每个 Module catalog entry 必须声明 Host compatibility、platform、immutable artifact hash 和签名身份；Module 更新失败不能改变 Host 版本或 Built-in Agent 的可用性。

## Changelog

用户可感知功能、修复、安全边界、权限、数据迁移和已知限制先进入 `CHANGELOG.md` 的 `Unreleased`。发布 PR 将这些条目移动到带日期的版本段；纯内部测试重构可以省略，但不得省略会改变 artifact 或用户行为的工程变更。
