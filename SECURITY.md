# Simulator 安全政策

## 支持版本

Simulator 目前尚未发布正式版本，因此暂时没有可列入安全支持范围的稳定版本。此政策适用于本仓库当前代码，以及未来由本仓库正式发布的 Simulator 版本。

版本窗口、Release Candidate 和 End of Support 规则见 [支持与版本政策](SUPPORT.md)。

## 报告安全漏洞

请仅通过 GitHub 的 [Private Vulnerability Reporting](https://github.com/Jiachi-Deng/Simulator/security/advisories/new) 私密报告安全漏洞。

请勿通过公开 GitHub Issue、Discussion、Pull Request 或其他公开渠道披露尚未修复的安全问题。如果 Private Vulnerability Reporting 页面不可用，请暂缓公开披露，并关注仓库后续提供的私密报告渠道。

报告中建议包含：

- 漏洞描述及潜在影响
- 受影响的组件、版本、commit 或运行环境
- 可复现步骤或最小复现样例
- 相关日志、截图或 proof of concept；提交前请移除无关的敏感信息
- 已知缓解措施或修复建议（如有）

## 处理方式

维护者会通过 GitHub Security Advisory 与报告者沟通、评估影响并协调修复。由于项目当前尚未正式发布，我们不承诺固定的确认、评估或修复 SLA；处理时间取决于漏洞的严重程度、可复现性和修复复杂度。

在维护者确认可以公开之前，请对漏洞细节、利用代码和相关讨论保密。

## 范围

以下问题通常属于本政策范围：

- Simulator 应用及本仓库维护的 packages 中的安全漏洞
- authentication、credential storage、permission boundary、Electron main/preload 隔离等安全边界问题
- updater、构建或发布流程中可能影响 Simulator 用户或产物完整性的问题

第三方 dependency 自身的漏洞应优先报告给对应维护者；如果该漏洞会通过 Simulator 的使用方式产生额外风险，也可以通过上述私密渠道报告。
