# OpenDesign artifact policy

本目录是 Phase 4 Issue #72 第一批可合并的 provenance、范围和离线校验基础设施。**当前不包含、也不会生成真实 OpenDesign artifact**，不包含上游源码、依赖、二进制或资源文件。

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

validator 不访问文件系统中的 artifact，也不跟随 symlink；若 inventory 声明 `type: "symlink"`，它只校验 `symlinkTarget` metadata 不逃逸 artifact root。实际打包器未来仍必须使用安全的文件遍历并禁止 TOCTOU/symlink 替换。

## 本地验证

```sh
cd modules/open-design
npm test
npm run typecheck
npm run build
```

CLI 可离线校验四个给定 JSON：

```sh
node src/validate-artifact.mjs \
  --provenance provenance.json \
  --policy artifact-policy.json \
  --decisions resource-decisions.json \
  --inventory fixtures/minimal-valid.inventory.json
```
