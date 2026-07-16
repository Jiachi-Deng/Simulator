# Changelog

本项目的主要变更记录在此文件中。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 新增手动触发的 unsigned macOS arm64 engineering RC bundle 流程，包含确定性校验、SPDX SBOM、SHA-256 校验和与 GitHub artifact attestation；该流程不会自动创建 tag 或 GitHub Release。
- 新增公开隐私政策、支持版本政策、Release Operations 与灾难恢复演练手册，并以 CI 校验公开构建默认不嵌入 Crash Reporting ingest URL。
- 新增 Host-owned `simulator-host-agent` 标准 JSONL CLI、v2 loopback HTTP/SSE contract 与独立 Electron Utility Process Broker，使 OpenDesign 可以直接复用当前 Craft Claude/Pi Runtime，而无需 OpenDesign Cloud 登录或外部 CLI 配置。
- 保留 OpenDesign `0.14.5` 的 v1 Compatibility Worker 回滚路径，并为 v1/v2 提供独立 token、epoch、资源限额与 circuit breaker。

### Changed

- OpenDesign v2 改为一 Turn 一 transient Craft Session，不恢复或自动重放崩溃中的 Module Turn；可见 Craft Turn 优先并会抢占正在运行的 Module Turn。

### Fixed

- Broker 在 create response 丢失时允许 Shim 用相同 Idempotency-Key 找回原 Run，并会有界清理从未被客户端接管的 Run，避免重复文件写入与残留隐藏 Session。
- Module 文件工具现在缺少授权边界即 fail-closed，并在执行前使用 canonical path 验证工作目录和目标路径。
