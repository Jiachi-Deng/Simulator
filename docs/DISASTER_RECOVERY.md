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
- 只使用仓库文档和 GitHub Release 中公开的输入；
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

在合成 macOS 用户中安装候选 DMG，保留上一版 DMG 和数据目录只读备份；制造可控的启动失败后卸载候选 app bundle、重新安装上一版并验证原会话只读打开。当前 Engineering RC updater 被禁用，因此不得用自动更新模拟回滚。预期：旧 app 可启动，数据目录 hash 除明确的日志文件外不变化。正式数据迁移尚未冻结时，此场景必须标记 `Not run` 并链接 Bundle ID/data migration ADR blocker。

### 4. Module rollback

Issue #71 的 packaged Fake Module gate 合并前，本场景必须标记为 `Not run (blocked by #71)`，不得手工伪造成功。合并后运行其专属 `smoke:module-coordinator:packaged` 命令，预期旧版本恢复、故障版本 quarantine，Built-in Agent 仍可启动。

### 5. Credential backend loss

只使用合成 profile：关闭应用，移动测试 profile 的 encrypted credential file，重新启动并执行需要 provider 的操作。预期：操作 fail closed、UI 要求重新认证、日志不出现 secret；测试结束后销毁整个合成 profile，不把真实 credential 文件用于演练。

### 6. Network loss

在干净设备上先确认没有活动写操作，再通过 macOS 系统设置断开网络；分别执行 Artifact 下载和合成 provider request。预期：有限时失败、可取消/重试、没有 partial Artifact 被激活。恢复网络后验证 last-known-good 仍可用。Catalog/Module 下载的正式 E2E 依赖 Issue #71，未合并前标为 `Not run`。

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
