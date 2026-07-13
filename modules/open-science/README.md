# OpenScience artifact baseline

这是 Issue #94 的 OpenScience artifact policy 与 staging 基础设施。仓库不提交真实 OpenScience binary、源码 checkout 或 production credentials；测试 fixture 中的 `TEST-ONLY-NOT-A-REAL-BINARY` 只是 validator sentinel，不是可发布 artifact。

## 固定来源

- 官方仓库：`https://github.com/synthetic-sciences/openscience`
- 稳定 release：`v1.3.4`（非 draft、非 prerelease）
- exact commit：`109a1b94329fa4cdd82e984b5a40bfe8842b5e6f`
- source date：`2026-07-11T07:22:21Z`
- license：`Apache-2.0`；artifact 必须携带 upstream `LICENSE`、`NOTICE` 及完整 `THIRD_PARTY_NOTICES`
- toolchain：Bun `1.3.5`，首发目标仅 `darwin-arm64`

构建必须预先保存并审核 `https://models.dev/api.json` 响应，以 `MODELS_DEV_API_JSON` 指向该文件，并记录其 SHA-256。禁止构建时回退到网络获取 snapshot。

模块内提交了经审核的离线快照 `policy/models-dev-api.json` 与其 decision。当前固定 digest 为 `bc75bbf216a1519d8b36fada7c1fe21fbc7b01f949998e9208f67f31a762e68b`；替换它需要同时更新 decision 并重新走法律/安全审核。

## Artifact contract

最小 artifact 只允许一个 Bun compiled `darwin-arm64` binary，包含 upstream embedded web 与 RDKit capability，并携带以下 leaf：

- `bin/openscience-darwin-arm64`
- `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES`
- `sbom.cdx.json`、`checksums.txt`
- `runtime-policy.json`、`provenance.json`、`third-party-decisions.json`
- `models-dev-api.json`
- `build-attestation.json`、`runtime-conformance.json`

validator 会递归枚举 artifact root，逐级 `lstat` 并检查 `realpath` containment。目录或 leaf symlink、未列 leaf、缺失 leaf、重复路径/角色、Unicode NFKC 或大小写碰撞都会失败。size 和 SHA-256 来自真实文件读取，inventory 只作为待核对声明。

`checksums.txt` 使用 `SHA256␠␠path` 格式，按 path 排序，覆盖除 `checksums.txt` 自身以外的每一个 artifact leaf。这样避免自引用 hash；`checksums.txt` 自身仍由 inventory 的真实 size/SHA-256 绑定。

官方 pinned 内容 hash：

- `LICENSE`: `d8ac5e917b2099e5cbe2999f297b56e2cc946e545f39aebc1e1aa91dd5cb0e9f`
- `NOTICE`: `7632b32824f48bc3d5f0654cfa2370c1821fc0086349f1d331c9d27b8d66e960`

SBOM、notices、decision inventory 和 provenance 均采用 unknown-field-rejecting schema，并绑定 source commit。所有 included component 必须以相同 ID/license 同时出现在 CycloneDX SBOM、`THIRD_PARTY_NOTICES` 和 decision inventory；任何未决 component 按 `defaultDecision: excluded` 拒绝。SBOM materials 还必须闭合 exact source commit 和 models.dev snapshot digest。

runtime 仅可监听系统分配的 loopback 端口，必须校验 `Host` 和 `Origin`。data/config/cache/state 分别落在 Host 分配的独立 `SIMULATOR_OPENSCIENCE_ROOT` 下。OpenScience 原生 Agent、MCP 与 permission 控制不得绕过。production credential 不得持久化；后续只能通过单独审计的 Host Bridge 实现。

静态 policy 不能证明 binary 的真实行为。因此发布校验必须注入两个独立 trust boundary：

- `TrustedProvenanceVerifier`：验证 binary subject digest、exact source repo/ref/commit、Bun version、models snapshot digest 和 network-disabled build。生产必须使用 GitHub artifact attestations、Sigstore 或 SLSA provenance 的可信验证结果；普通 JSON 本身不可信。
- `TrustedRuntimeConformanceVerifier`：验证与同一 binary digest 绑定的 dynamic loopback bind、`Host`/`Origin` 拒绝行为和 production credential persistence 拒绝行为。静态 `runtime-policy.json` 不能替代该证据。

任一 verifier 未注入或返回不可信，validator 默认 fail closed。单元测试明确注入 `test-only-deterministic-fake-*` verifier，只用于测试 binding 和失败路径，禁止用于生产。

第三方 API、数据、模型、远程 asset 或未知 license 项默认排除。允许项必须在 decision inventory、SBOM 和 notices 中同时闭合。

## 校验

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run diff-check
node dist/src/cli.js \
  /path/to/artifact \
  /path/to/inventory.json \
  /path/to/trusted-provenance-verifier \
  /path/to/trusted-runtime-verifier
```

CLI 将 `{ evidence, expected }` JSON 写入 verifier stdin，只接受 exit code `0` 且 stdout 为 strict `{ "trusted": true, "subject": string, "source": string, "evidence": string }`，不允许额外字段或 Symbol key。validator 会在调用 verifier 前冻结独立的 `expected` clone，并按调用前保存的 identity 校验该结果。verifier executable 的安装、身份和 trust root 由 Host/发布流水线负责。

validator 完全离线并 fail closed。它拒绝未知 schema 字段、source/profile 不匹配、错误架构或 hash、缺失法律/SBOM/snapshot/evidence 文件、非 loopback policy、共享或可 alias 的 XDG root、源码/dev dependencies、其他架构、明文 auth/credential 文件、路径逃逸或 Unicode/大小写碰撞，以及超限文件。

## Sealed staging

`stage-open-science` 不接受 caller source path。它在 release 输出同级创建权限为 `0700` 的私有 checkout，fetch/detach 到固定 commit，并核对根 `bun.lock` 的 SHA-256：`702eecf22d18e468484f40351ad5f0a7d40fc645784ff93b882c8a63588b4bb1`。

它只接受 Bun `1.3.5`，使用 `sandbox-exec` deny-network profile 执行 `bun install --frozen-lockfile --offline`，随后以 `MODELS_DEV_API_JSON` 和 `--skip-install` 运行上游 build。产物必须是可执行的 thin `darwin-arm64` Mach-O；脚本、fat binary 和其他平台都会失败。源码没有被 copy、flatten 或放入 artifact。

外部 legal evidence 目录必须包含 `legal-review.json`、`THIRD_PARTY_NOTICES`、`sbom.cdx.json` 和 `third-party-decisions.json`。review 必须绑定 exact repo/ref/commit/bun.lock。build attestation 和 runtime conformance 也必须作为外部证据传入，并由现有两个 trusted verifier 验证后才能封存。

```json
{
  "releaseRoot": "/private/tmp/openscience-release",
  "legalEvidenceDirectory": "./legal-review",
  "buildAttestationPath": "./build-attestation.json",
  "runtimeConformancePath": "./runtime-conformance.json",
  "bunExecutable": "/opt/toolchains/bun-1.3.5/bin/bun",
  "provenanceVerifier": "/opt/trust/verify-provenance",
  "runtimeVerifier": "/opt/trust/verify-runtime"
}
```

运行 `node dist/src/staging-cli.js staging-config.json` 后，release root 会一次性出现：`artifact/`、inventory、tar.gz 及 archive checksum。封存前完整 artifact 已通过 validator；全部文件和目录会改为 owner-read/execute，避免后续修改。任何 snapshot、toolchain、source、lock、legal、build 或 trusted evidence 问题都会清理临时目录，并只留下 `<releaseRoot>.failure.json`，不会产生部分 artifact。

`startStagedBinary` 在启动前再次调用 validator 和 trusted verifier。它为 child 创建独立 `SIMULATOR_OPENSCIENCE_ROOT` 及四个 XDG 根、剥离 credential-shaped 环境变量、以 host 分配的 `127.0.0.1` 动态端口启动，并实际 probe 非法 `Host` 和 `Origin`。停止时会终止整个 process group、检查 credential-shaped 持久化内容并删除隔离根。返回的 runtime probe record 绑定 binary SHA-256，供独立 runtime verifier 签发/验证；它不将 policy JSON 当作 runtime proof。
