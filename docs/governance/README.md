# Simulator 项目治理文档

本目录记录 Simulator 作为独立开源产品的长期治理决策。文档描述目标状态和迁移约束，不代表所有配置已经在源码、GitHub 或外部服务中生效。

## 当前文档

- [产品身份表](./identity.md)：产品名、仓库、Bundle ID、deep link、数据目录、package scope 和外部服务身份。
- [第三方软件、品牌与来源清单](./third-party-inventory.md)：发行制品中的许可证、商标、binary、依赖和 provenance 风险。
- [去品牌迁移方案](./branding-migration.md)：从 Craft identity 迁移到 Simulator 的兼容策略、阶段和测试门。

## 维护规则

1. 身份字段发生变化时，先修改 `identity.md` 并通过 PR Review，再修改实现。
2. 新增随产品分发的 dependency、binary、字体、模型、图片或第三方 logo 时，同一 PR 必须更新第三方清单。
3. 从任何外部项目迁移代码前，必须记录仓库、完整 commit SHA、许可证、文件映射和导入方式。
4. `Pending` 字段不得被当作生产配置，也不得使用无人控制的占位 URL 或邮箱。
5. 每个 Release Candidate 都应基于最终 artifact 重新生成 SBOM 和 third-party notices，而不是复用旧版本报告。

## 当前阻断项

- 产品域名、文档站点、安全邮箱、法务联系方式和签名主体尚未确定。
- `@simulator/*` npm scope 和建议 Bundle ID 尚未完成外部所有权验证。
- Updater、OAuth、share viewer 和 MCP/docs 仍依赖 Craft 基础设施。
- Pi fork 和 Claude Agent SDK/native binary 尚未完成发行版本级 provenance 与条款归档。
- 当前图标和多个第三方 logo 尚未建立逐文件授权台账。

在这些阻断项解决前，可以继续进行研究、测试和内部重构，但不能发布 Simulator 品牌的正式安装包。
