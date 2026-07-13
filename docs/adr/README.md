# Architecture Decision Records

Simulator 使用 Architecture Decision Record（ADR）记录会长期影响架构、兼容性、安全边界、发布流程或维护成本的决定。ADR 不是会议记录，也不用于替代 Issue、PR 或实现文档。

## 何时需要 ADR

以下变更在实现前应提交 ADR：

- Bundle ID、URL protocol、数据目录或迁移策略；
- Module、Runtime、credential、approval、network 或 filesystem 的信任边界；
- 对外协议、持久化格式或兼容性承诺；
- 发布、更新、签名、公证或回滚机制；
- 会限制未来实现方向的重要技术选择。

局部 Bug 修复、依赖 patch、内部重命名和容易回滚的实现细节通常不需要 ADR。

## 状态

- `Proposed`：正在讨论，尚不构成产品承诺；
- `Accepted`：已通过 PR Review 并合并到 `main`，是当前有效决定；
- `Rejected`：已评估但不采用，保留原因供未来参考；
- `Superseded`：已被后续 ADR 取代，必须链接替代记录。

只有合并到 `main` 且状态为 `Accepted` 的 ADR 才具有约束力。Issue、草稿、Obsidian 笔记和 `Proposed` ADR 中的示例值都不得描述为已锁定事实。

## 创建流程

1. 复制 [0000-template.md](0000-template.md)，使用下一个四位编号和简短 slug，例如 `0001-module-process-isolation.md`。
2. 在关联 Issue 中说明用户问题、候选方案、风险和需要的决策。
3. ADR 与相关实现可以在同一 PR 中 Review；高风险边界优先先合并 ADR，再开始实现。
4. 记录可验证的后果、回滚路径和被拒绝方案，避免只写结论。
5. 已接受 ADR 不原地改写历史。改变决定时新增 ADR，并把旧记录标记为 `Superseded`。

编号只表达创建顺序，不表达优先级。删除或复用已公开编号均不允许。
