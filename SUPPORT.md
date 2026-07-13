# Simulator 支持与版本政策

## 当前发布状态

Simulator 尚未发布稳定版本。当前 `main`、源码构建和 unsigned Engineering RC 都属于预发布工程产物，不承诺生产环境 SLA，也不构成长期支持版本。

## 版本规则

Simulator 使用 SemVer：`MAJOR.MINOR.PATCH`。

- `MAJOR`：包含明确不兼容变更；
- `MINOR`：向后兼容的功能增加；
- `PATCH`：向后兼容的 Bug 或安全修复；
- `-rc.N`：Release Candidate，可能在稳定发布前继续变化。

所有可分发 workspace 使用同一个版本号。Git tag、Release、Artifact、Checksum、SBOM 和 Provenance 必须指向同一 commit；不满足这一条件的产物不得作为官方 Release 发布。

## 支持窗口

稳定版本发布前，仅接受针对最新 `main` 和最新公开 RC 的问题报告，修复按维护者可用时间进行，不承诺回移到旧预发布版本。

首个稳定版本发布后，默认支持规则为：

- 最新稳定 `MINOR`：接收 Bug 和安全修复；
- 前一个稳定 `MINOR`：仅接收 Critical/High 安全修复；从后继稳定 `MINOR` 发布日开始计算，最长支持 90 个自然日；
- 更早版本、所有被后续 RC 取代的 RC：End of Support。

每次稳定发布必须在本文件的支持矩阵和对应 GitHub Release notes 中记录发布日期、当前支持线和计划 EoS 日期。EoS 至少通过后继 Release notes 公告；安全原因需要缩短窗口时，通过 GitHub Security Advisory 说明。维护者可以因严重回归延长窗口，但必须更新同一记录。自动下载的 Module 可以拥有独立版本，但必须声明与 Host 的兼容范围。

当前支持矩阵：

| Release line | 状态 | EoS |
| --- | --- | --- |
| 最新 `main` / 最新 Engineering RC | Pre-release，best effort | 被后续 RC 取代时 |
| Stable | 尚未发布 | Not applicable |

## 安全补丁

安全漏洞通过 [SECURITY.md](SECURITY.md) 的私密渠道处理。修复通过受保护分支、Required CI 和可验证 Release 交付。维护者不会为了隐藏失败而静默切换 Runtime、降低审批要求或绕过 Artifact 验证。

由于项目当前由单一维护者推进，不承诺固定响应或修复 SLA。Critical/High 问题会优先于普通功能；无法安全修复时可以关闭相关 feature flag、撤回 Artifact 或标记版本为不受支持。

## 获得帮助

- 可复现 Bug：使用 Bug Report Issue Form；
- 功能建议：使用 Feature Request Issue Form；
- 未公开漏洞：使用 GitHub Private Vulnerability Reporting；
- 上游项目行为：先确认问题是否也存在于 Simulator 当前 commit，再决定向哪个项目报告。

提交日志、数据库、项目或截图前必须移除凭据和私人内容。
