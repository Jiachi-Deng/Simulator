# OpenDesign artifact policy

本目录包含 OpenDesign artifact 的 provenance、范围 policy、真实 staging inventory producer 和离线 validator。它不下载或构建上游源码，也不包含上游依赖、二进制或资源文件。

## 固定来源

只读审计官方仓库 `https://github.com/nexu-io/open-design` 后，选择最新稳定 tag `open-design-v0.14.1`，固定到 commit `2225647726d5387bb24e9539fdb577958b6d88c6`。审计时 `HEAD` 为另一个 commit，因此不能替代 pinned ref。上游根 manifest 声明 Apache-2.0、Node 24、pnpm 10.33.2；详细信息见 `provenance.json`。

## 最小生产 profile

允许的目标只有：

- Next.js standalone server，以及对应 static/public 文件。
- OpenDesign daemon 与其运行所需的 production runtime。
- LICENSE、SPDX SBOM、provenance 和 artifact manifest。

明确排除 nested Electron、desktop/packaged app、installer、updater、dev dependencies、cache、test、coverage、plugin 和 skill。模板、字体、图片及 native binaries 不会因位于允许目录就自动获准；它们必须先在 `resource-decisions.json` 中完成逐项权利和风险决策。

## 计划中的生产流程

1. 在隔离、可复现的构建环境中 checkout `provenance.json` 的精确 commit，并核对 tag 指向。
2. 使用上游 lockfile、Node 24 和 pnpm 10.33.2 构建 Next standalone 与 daemon/runtime。
3. 只收集 `artifact-policy.json` allowlist 内的 production 输出，生成 SPDX SBOM 和 artifact inventory。
4. 对每个模板、字体、图片、plugin、skill 和 native binary 完成 `resource-decisions.schema.json` 所定义的决策。未知权利保持 `review`/`pending` 或 `exclude`，不得进入 artifact。
5. 对 native binary 记录 `platform`、`arch`、`nodeAbi`、`libc`，并按目标平台分别验证。
6. 离线运行 validator；通过后才允许后续签名、归档或分发步骤。

validator 不访问文件系统中的 artifact。`produce-inventory.mjs` 负责安全读取一个已经完成构建和筛选的 staging root：逐级 `lstat`/`realpath` containment，不跟随 symlink，只接受 regular files；打开 descriptor 后以 `fstat` 绑定 identity，流式计算 SHA-256 和 bytes，再检查 descriptor 与路径的 dev/inode/size/mtime 未变化。hard-link alias、特殊文件、采集期间替换和修改均会失败。

producer 使用 UTF-8 byte order 排序，并拒绝 NFKC + full Unicode case-fold collision。每个 staged leaf 必须被现有 exact/prefix path rule 覆盖。字体、图片和 native binary 必须在 metadata map 中以 artifact exact path 提供资源 metadata；多余路径、未知字段和缺失 metadata 都会 fail closed。生成后 producer 会立即调用同一个 `validateArtifact`，不会输出未验证 inventory。

`artifact-manifest.json` 是 producer 的输出，不得预先出现在 staging root。producer 会合成其 inventory entry，稳定计算 canonical JSON bytes，并按 validator 已定义的 self-digest 规则绑定 inventory。

所有输入会在运行时通过严格 schema，未知字段和未知 enum 会 fail closed。每个 inventory file 都有独立 `schemaVersion`、size 和 SHA-256。required legal/metadata 文件必须是正确 kind 的 regular file；provenance digest 绑定 canonical JSON 内容，manifest digest 则绑定“将 `artifact-manifest.json` 自身 `sha256` 置为 64 个 `0` 后”的 canonical inventory，避免自引用循环。SPDX SBOM 还必须绑定固定 media type、schema version 和 source commit。

## 本地验证

```sh
cd modules/open-design
npm test
npm run typecheck
npm run build
npm run diff-check
```

CLI 可离线校验四个给定 JSON：

```sh
node src/validate-artifact.mjs \
  --provenance provenance.json \
  --policy artifact-policy.json \
  --decisions resource-decisions.json \
  --inventory fixtures/minimal-valid.inventory.json
```

## 从 staging 生成 inventory

staging root 必须是 absolute path，并包含 policy 要求的所有其他文件，例如 `provenance.json`、LICENSE 和 SPDX SBOM。CLI 只读取 staging 和本模块的本地 policy/provenance/decision 文件，不联网，也不触发上游 build。

target 文件示例：

```json
{"platform":"darwin","arch":"arm64","nodeAbi":"137","libc":"none"}
```

没有资源或 native binary 时，metadata 文件是空 map：

```json
{}
```

资源 metadata 以 artifact exact path 为 key。`sourcePath` 和 `decisionId` 必须精确匹配 `resource-decisions.json` 中已批准的 decision；native binary 还必须提供与 target 一致的 `nativeTarget`：

```json
{
  "runtime/packages/addon.node": {
    "resourceCategory": "native-binaries",
    "sourcePath": "packages/addon.node",
    "decisionId": "approved-addon",
    "nativeTarget": {"format":"node-addon","platform":"darwin","arch":"arm64","libc":"none","nodeAbi":"137"}
  }
}
```

输出到 stdout，或使用 `--output` 以 exclusive-create 方式写入一个尚不存在的文件（可直接指定 staging root 下的 `artifact-manifest.json`）：

```sh
npm run inventory -- \
  --staging-root /absolute/path/to/staging \
  --metadata /absolute/path/to/metadata.json \
  --target /absolute/path/to/target.json \
  --output /absolute/path/to/artifact-manifest.json
```
