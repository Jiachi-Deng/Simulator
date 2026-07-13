# 为 Simulator 贡献

感谢你参与 Simulator。本文描述当前公开仓库的实际贡献流程与 CI 基线；如本文与仓库中的 GitHub Actions 配置不一致，以 `.github/workflows/` 为准，并欢迎提交文档修正。

## 开始之前

- 仓库：<https://github.com/Jiachi-Deng/Simulator>
- Runtime 与包管理器：[Bun 1.3.10](https://bun.sh/)
- 桌面应用基于 Electron；文档工具 smoke tests 还需要 Python 3。

请先搜索现有 [Issues](https://github.com/Jiachi-Deng/Simulator/issues)，确认问题尚未被报告或认领。Bug 请使用 Bug report 模板并提供系统版本、复现步骤、预期行为、实际行为及必要日志；功能建议请说明使用场景和预期价值。较大的功能、架构调整或破坏性变更，应先开 Issue 与维护者对齐范围，再开始实现。

会长期影响兼容性、安全边界、持久化格式或发布机制的决定还应遵循 [Architecture Decision Record 流程](docs/adr/README.md)。只有合并到 `main` 且状态为 `Accepted` 的 ADR 才是有效决定；不要把 Issue、草稿或示例值当作已锁定产品承诺。

## 本地设置

```bash
git clone https://github.com/Jiachi-Deng/Simulator.git
cd Simulator
bun install --frozen-lockfile
bun run electron:dev
```

如你通过 fork 贡献，请将自己的 fork 配置为 `origin`，并保留上游仓库地址以便同步 `main`。

## 分支与开发

从最新的 `main` 创建范围单一、名称清晰的分支：

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description
```

推荐前缀包括 `feat/`、`fix/`、`docs/`、`refactor/` 和 `test/`。一次 PR 只处理一个明确问题；遵循相邻代码的 TypeScript、React 和 Electron 模式，不夹带无关重构。行为变化应补充与风险相称的测试，UI 变化应准备截图或录屏。

实现开始后即可推送分支并创建 **Draft PR**。这样维护者可以尽早确认方向，也能让 CI 持续暴露问题。PR 描述至少包含：

- 关联 Issue，例如 `Closes #123`；
- 改动原因与实现摘要；
- 实际运行过的验证命令及结果；
- 未覆盖项、已知失败与残余风险；
- UI 变更的前后截图或录屏。

## 当前 Public Baseline

`.github/workflows/validate.yml` 是当前 PR required baseline。提交前请尽量在仓库根目录运行与 CI 一致的命令：

```bash
bun install --frozen-lockfile
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run test:shared:llm-connections
bun run test:doc-tools
```

CI 还会拒绝名称包含 Windows 非法字符 `< > : " | ? *` 的已跟踪文件。可在提交前检查：

```bash
git ls-files | grep -E '[<>:"|?*]'
```

该命令无输出时符合此项要求。`Validate Server (Integration)` 是使用 secrets 的手动 workflow，目前不属于普通 PR 的 Public Baseline。

### 关于 typecheck 与完整 build

`bun run typecheck:all`、`bun run validate:dev`、`bun run validate:ci` 和完整 `bun run build` **目前不是 Public Baseline 的 required checks**。公开 OSS 基线中仍存在会影响全量 typecheck 或完整 build 的已知问题，因此不要在没有实际成功运行的情况下写“全部通过”。

如果你的改动涉及相关 package，请运行能够覆盖该范围的 typecheck、测试或 build，并在 PR 中逐项记录真实结果。若全量命令失败，请附上命令、关键错误和判断：它是既有 baseline issue，还是由本 PR 引入。新增回归必须在进入 review 前修复；既有问题也不得隐瞒或伪称通过。

## CI、Review 与合并

1. 保持 PR 为 Draft，直到范围稳定、Public Baseline 通过且描述完整。
2. 将分支同步到最新 `main`，解决冲突，并确认 CI 结果属于最新 commit。
3. 标记 Ready for review。维护者会关注正确性、兼容性、测试覆盖、用户体验与维护成本。
4. 逐条处理 review 意见；有不同判断时说明依据和取舍。代码更新后同步更新测试证据与截图。
5. CI 未通过、review 未解决或 PR 描述仍声称未经验证的结果时，不应合并。最终合并方式由维护者决定。

## Commit 与 DCO

使用简洁、可追溯的 commit message，避免把无关修改混入同一 commit。

本仓库当前未安装 DCO bot，也未启用 `Signed-off-by` 检查，因此 **DCO 暂不启用，贡献者目前无需添加 `Signed-off-by`**。如果未来启用 DCO，应由维护者先更新仓库设置、CI 与本文，再将签署要求作为正式门禁；在此之前不要把它描述为强制要求。

## 许可证

提交贡献即表示你同意按照本仓库的 [Apache License 2.0](LICENSE) 许可你的贡献。
