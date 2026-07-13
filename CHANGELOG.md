# Changelog

本项目的主要变更记录在此文件中。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 新增手动触发的 unsigned macOS arm64 engineering RC bundle 流程，包含确定性校验、SPDX SBOM、SHA-256 校验和与 GitHub artifact attestation；该流程不会自动创建 tag 或 GitHub Release。
- 新增公开隐私政策、支持版本政策、Release Operations 与灾难恢复演练手册，并以 CI 校验公开构建默认不嵌入 Crash Reporting ingest URL。
