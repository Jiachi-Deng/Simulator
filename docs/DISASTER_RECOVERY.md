# Disaster Recovery Drill

每季度至少演练一次；在第一次真实公开 Release 前必须完成一次。未执行的步骤只能标记为 `Not run`，不得写成已通过。

## 目标

- 从干净 clone 重建精确版本；
- 验证 Release Artifact 没有依赖开发机残留状态；
- 恢复 last-known-good Host 与 Module；
- 验证 credential、用户项目和历史不会因回滚被静默覆盖；
- 确认单个可选 Module 故障不会阻止 Built-in Agent 启动。

## 前置条件

- 使用与日常开发不同的干净 macOS 用户或设备；
- 记录 OS、CPU、Xcode/CLI tools、Bun 和 commit；
- 只使用仓库文档、Engineering RC 的 GitHub Actions artifact，或稳定版上线后的 GitHub Release 公开输入；
- 使用合成测试数据，不使用真实用户凭据。

## 演练场景

### 1. Source recovery

```bash
git clone https://github.com/Jiachi-Deng/Simulator.git simulator-drill
cd simulator-drill
git checkout FULL_SOURCE_SHA
test -z "$(git status --porcelain)"
bun install --frozen-lockfile
bun run validate:ci
bun run build
```

预期：checkout 保持 clean，全部命令退出码为 0，版本与目标 Release/RC 完全一致。

### 2. Artifact recovery

Engineering RC 使用 Actions artifact，不冒充公开 Release：

```bash
gh run download RUN_ID --repo Jiachi-Deng/Simulator \
  --name simulator-VERSION-macos-arm64-unsigned \
  --dir recovered-rc
(cd recovered-rc && shasum -a 256 -c SHA256SUMS)
bun scripts/release/verify-bundle-policy.ts recovered-rc
```

预期：Checksum 与 updater-leak policy 均通过，SBOM、provenance bundle 和 validation metadata 存在。稳定版上线后再增加签名、notarization 和公开 GitHub Release 下载验证。

### 3. Host rollback

正式 Bundle ID、数据目录和 migration ADR 尚未冻结，因此本场景当前必须记录为 `Not run (blocked by product identity decision)`。不得在真实用户目录手工猜测路径。决策完成后，runbook 必须补充专用测试用户、候选/上一版 DMG、数据 snapshot/hash、安装/恢复命令与允许变化的日志清单，才能把本项改为可执行。

### 4. Module rollback

Issue #71 的 packaged Fake Module gate 合并前，本场景必须标记为 `Not run (blocked by #71)`，不得手工伪造成功。合并后运行其专属 `smoke:module-coordinator:packaged` 命令，预期旧版本恢复、故障版本 quarantine，Built-in Agent 仍可启动。

### 5. Credential backend loss

当前 credential backend 没有可注入的 profile root，直接设置 `HOME` 仍可能误触系统路径；本场景必须记录为 `Not run (blocked by credential isolation test seam)`。先建立可注入 storage root 和合成 credential fixture，再补充自动命令。不得移动真实 `~/.craft-agent/credentials.enc` 作为演练。

### 6. Network loss

当前可执行的 downloader 网络失败/timeout/cancel 门：

```bash
bun test packages/module-downloader/src/downloader.test.ts \
  packages/module-downloader/src/node-adapters.test.ts
```

预期：全部测试通过，并证明 retry、timeout、cancel、partial cleanup 和 last-known-good cache 语义。真实 packaged App 的断网与 provider request 尚无隔离 fixture，必须记录为 `Not run (blocked by packaged network fixture)`；Catalog/Module 的完整 packaged E2E 同时依赖 Issue #71。

### 7. Maintainer recovery

在另一台干净设备只依据 `README.md`、`SECURITY.md`、`SUPPORT.md` 和本手册完成场景 1、2。预期：不需要开发机私有文件或未记录 secret；任何缺失步骤建立公开 Issue，漏洞细节除外。

## Evidence Template

```text
Drill date:
Operator:
Target commit/tag/version:
Environment:
Scenario results (Pass/Fail/Not run):
Artifact and CI links:
Observed recovery time:
Data integrity checks:
Findings and linked Issues:
Follow-up owner and due date:
Overall Go/No-Go:
```

Evidence 可以作为 GitHub Issue 或 Release checklist 保存，但不得包含 token、真实项目内容、个人路径或未公开漏洞细节。任何 `Fail` 必须建立 Issue；涉及未公开漏洞时使用 Private Vulnerability Reporting。
