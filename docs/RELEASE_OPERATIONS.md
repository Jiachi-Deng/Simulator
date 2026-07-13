# Release Operations Runbook

本手册用于单一维护者执行可审计的月度维护与 Release 准备。它不会替代签名、公证或用户验收。

## 每月依赖与上游审查

1. 记录审查日期、维护者、当前 `main` commit 和最近 Release。
2. 检查 Dependabot PR、GitHub Advisory、锁文件变化和过期 GitHub Actions。
3. Fetch `upstream`，对比从上次记录的 upstream commit 到目标 commit 的代码、迁移、许可证与破坏性变更。
4. 对每项升级建立独立 Issue；高风险 Runtime、Electron、credential、database 和 updater 变更不得混入普通 dependency batch。
5. 在独立分支执行 frozen install、`bun run validate:ci`、全部 production build 和对应 packaged smoke。
6. 记录接受、推迟或拒绝的原因；不要直接 push `main`。
7. 合并后验证 `main` Required CI，并把结果链接写入 evidence。

Evidence 至少包含：

```text
Review month:
Operator:
Main commit before/after:
Upstream range reviewed:
Dependency alerts reviewed:
Issues/PRs opened:
CI and packaged-smoke links:
Deferred risks and owner:
```

## Release Candidate 准备

1. 版本必须是合法的 `MAJOR.MINOR.PATCH-rc.N`，并在所有 distributable workspace 中一致。
2. Release notes 必须对应精确 commit，包含已知限制、隐私/权限变化和回滚说明。
3. 从受保护的 `main` 或明确批准的 release branch 构建；禁止从脏工作区发布。
4. 生成并验证 DMG/ZIP、`SHA256SUMS`、SPDX SBOM 和 provenance/attestation。
5. unsigned Engineering RC 必须明确标记 unsigned、禁用生产 updater，且不能冒充可自动更新的稳定发行版。
6. 签名发行必须验证 Developer ID、notarization、stapling、Gatekeeper 和干净设备安装。
7. 发布前执行 [灾难恢复演练](DISASTER_RECOVERY.md) 中当前可执行且与本次变更相关的恢复路径；尚未实现的 Module 场景必须标为 `Not run` 并链接 blocker。

## Go/No-Go

以下任一情况直接 `No-Go`：

- Required CI、Artifact verification 或 packaged smoke 失败或被跳过；
- commit、tag、版本、Checksum、SBOM 或 provenance 不一致；
- 发现凭据泄露、越权写入、错误审批关联、不可恢复历史或未解释的网络上传；
- 无法恢复 last-known-good Artifact；
- 正式构建缺少已经承诺的签名、公证或隐私披露。

## 发布后

1. Engineering RC 从 GitHub Actions run 使用 `gh run download RUN_ID --name simulator-VERSION-macos-arm64-unsigned` 重新下载；稳定版存在后才从公开 GitHub Release 页面下载。不得复用本地 build 输出。
2. 重新计算 Checksum，验证签名、公证、架构和 SBOM。
3. 在干净用户账户完成安装、首次启动、Built-in Agent 与 Module 基础 smoke。
4. 检查公开构建没有意外嵌入 credential、DSN 或 production updater endpoint。
5. 记录结果；失败时撤回 Artifact 或发布明确告警，不静默替换同名文件。
