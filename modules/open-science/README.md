# OpenScience artifact baseline

这是 Issue #73 第一批可合并的 artifact policy baseline，**不包含真实 OpenScience binary、源码 checkout 或 production credentials**。

## 固定来源

- 官方仓库：`https://github.com/synthetic-sciences/openscience`
- 稳定 release：`v1.3.4`（非 draft、非 prerelease）
- exact commit：`109a1b94329fa4cdd82e984b5a40bfe8842b5e6f`
- source date：`2026-07-11T07:22:21Z`
- license：`Apache-2.0`；artifact 必须携带 upstream `LICENSE`、`NOTICE` 及完整 `THIRD_PARTY_NOTICES`
- toolchain：Bun `1.3.5`，首发目标仅 `darwin-arm64`

构建必须预先保存并审核 `https://models.dev/api.json` 响应，以 `MODELS_DEV_API_JSON` 指向该文件，并记录其 SHA-256。禁止构建时回退到网络获取 snapshot。

## Artifact contract

最小 artifact 只允许一个 Bun compiled `darwin-arm64` binary，包含 upstream embedded web 与 RDKit capability，并携带 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES`、CycloneDX JSON SBOM、checksums 和 `runtime-policy.json`。inventory 必须绑定 exact source pin、架构、每个文件的 size 和 SHA-256。

runtime 仅可监听系统分配的 loopback 端口，必须校验 `Host` 和 `Origin`。data/config/cache/state 分别落在 Host 分配的独立 `SIMULATOR_OPENSCIENCE_ROOT` 下。OpenScience 原生 Agent、MCP 与 permission 控制不得绕过。production credential 不得持久化；后续只能通过单独审计的 Host Bridge 实现。

第三方 API、数据、模型、远程 asset 或未知 license 项默认排除。允许项必须在 decision inventory、SBOM 和 notices 中同时闭合。

## 校验

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run diff-check
node dist/src/cli.js /path/to/artifact /path/to/inventory.json
```

validator 完全离线并 fail closed。它拒绝未知 schema 字段、source/profile 不匹配、错误架构或 hash、缺失法律/SBOM 文件、非 loopback policy、共享 XDG root、源码/dev dependencies、其他架构、明文 auth/credential 文件、路径逃逸或 Unicode/大小写碰撞，以及超限文件。
