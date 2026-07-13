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

1. **Source recovery**：从 tag/commit 干净 clone，frozen install，运行完整 CI 和生产 build。
2. **Artifact recovery**：下载公开 Artifact，验证 Checksum、SBOM、provenance、架构以及签名状态。
3. **Host rollback**：安装候选版本，制造可控启动失败，恢复 last-known-good，验证用户数据未被降级写坏。
4. **Module rollback**：安装 Fake Module，升级到故障版本，验证旧版本仍可启动且故障版本被隔离。
5. **Credential loss**：使用测试 profile 模拟 Keychain/credential backend 不可用，验证 fail-closed 且日志不泄露 secret。
6. **Network loss**：在下载、Catalog refresh 和 provider turn 期间断网，验证有限时失败、可重试且无半安装状态。
7. **Maintainer recovery**：验证另一台干净设备可依据文档找到 security、support、build 和 release 流程。

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
