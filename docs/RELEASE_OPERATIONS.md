# Release Operations Runbook

本手册用于单一维护者执行可审计的月度维护与 Release 准备。它不会替代签名、公证或用户验收。

## 每月依赖与上游审查

1. 建立当月 evidence 目录，并记录当前状态：

   ```bash
   MONTH=$(date +%Y-%m)
   mkdir -p "release-evidence/$MONTH"
   git fetch origin upstream --tags --prune
   git rev-parse origin/main | tee "release-evidence/$MONTH/main-before.txt"
   git status --short --branch | tee "release-evidence/$MONTH/worktree.txt"
   gh pr list --repo Jiachi-Deng/Simulator --search 'author:app/dependabot' \
     --json number,title,url,state > "release-evidence/$MONTH/dependabot-prs.json"
   gh api repos/Jiachi-Deng/Simulator/dependabot/alerts \
     > "release-evidence/$MONTH/dependabot-alerts.json"
   ```

2. 从上次 evidence 记录的 upstream commit 到目标 commit 审查代码、迁移、许可证与破坏性变更：

   ```bash
   git log --oneline LAST_UPSTREAM_SHA..upstream/main \
     | tee "release-evidence/$MONTH/upstream-commits.txt"
   git diff --stat LAST_UPSTREAM_SHA..upstream/main \
     | tee "release-evidence/$MONTH/upstream-stat.txt"
   ```

3. 对每项升级建立独立 Issue；高风险 Runtime、Electron、credential、database 和 updater 变更不得混入普通 dependency batch。
4. 在独立 branch/worktree 执行仓库级门，并保留日志：

   ```bash
   bun install --frozen-lockfile
   bun run validate:ci 2>&1 | tee "release-evidence/$MONTH/validate-ci.log"
   bun run electron:build 2>&1 | tee "release-evidence/$MONTH/electron-build.log"
   bun run server:build 2>&1 | tee "release-evidence/$MONTH/server-build.log"
   bun run viewer:build 2>&1 | tee "release-evidence/$MONTH/viewer-build.log"
   bun run webui:build 2>&1 | tee "release-evidence/$MONTH/webui-build.log"
   ```

5. macOS arm64 packaged smoke 必须通过 GitHub 的 `macOS Package Smoke` workflow 执行；当前没有 Windows/Linux packaged Release gate，因此对应项必须记为 `Not run`，不能用普通 build 代替：

   ```bash
   gh workflow run package-macos.yml --repo Jiachi-Deng/Simulator --ref BRANCH_OR_SHA
   gh run list --repo Jiachi-Deng/Simulator --workflow package-macos.yml --limit 1
   gh run watch RUN_ID --repo Jiachi-Deng/Simulator --exit-status
   ```

6. 记录接受、推迟或拒绝的原因；不要直接 push `main`。合并后用 `gh run list --branch main` 验证 Required CI，并把 URL 写入 evidence。

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

触发当前 Engineering RC 的精确命令：

```bash
SOURCE_SHA=$(git rev-parse origin/main)
VERSION=0.12.0-rc.1 # 必须先完成版本与 release notes 决策
gh workflow run engineering-rc.yml --repo Jiachi-Deng/Simulator \
  -f version="$VERSION" \
  -f source_sha="$SOURCE_SHA"
gh run list --repo Jiachi-Deng/Simulator --workflow engineering-rc.yml --limit 1
gh run watch RUN_ID --repo Jiachi-Deng/Simulator --exit-status
```

不得直接照抄示例版本发布；`scripts/release/engineering-rc.ts` 会拒绝版本、notes、tag、dirty tree 或非 `origin/main` source 不一致。

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
