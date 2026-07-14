# OpenDesign artifact policy

本目录包含 OpenDesign artifact 的 provenance、范围 policy、生产 staging build runner、安全 copier、native inventory、真实 staging inventory producer 和离线 validator。仓库不提交上游依赖、二进制或其他大型 build artifact。

## 固定来源

只读审计官方仓库 `https://github.com/nexu-io/open-design` 后，选择最新稳定 tag `open-design-v0.14.1`，固定到 commit `2225647726d5387bb24e9539fdb577958b6d88c6`。审计时 `HEAD` 为另一个 commit，因此不能替代 pinned ref。上游根 manifest 声明 Apache-2.0、Node 24、pnpm 10.33.2；详细信息见 `provenance.json`。

## 最小生产 profile

允许的目标只有：

- Next.js standalone server，以及对应 static/public 文件。
- OpenDesign daemon 与其运行所需的 production runtime。
- LICENSE、producer 生成的 SPDX SBOM、resource metadata、provenance、build attestation 和 artifact manifest。

明确排除 nested Electron、desktop/packaged app、installer、updater、dev dependencies、cache、test、coverage、plugin 和 skill。模板、字体、图片及 native binaries 不会因位于允许目录就自动获准；它们必须先在 `resource-decisions.json` 中完成逐项权利和风险决策。

## 生产 staging 流程

1. `stage-open-design.mjs` 验证 upstream `origin`、完整 commit、tag、根 manifest、Node `~24`、精确 `pnpm@10.33.2`，以及 `provenance.json` 固定的 `pnpm-lock.yaml` SHA-256。
2. checkout 必须 clean；唯一例外是当前 pinned Next.js 会生成的 `apps/web/next-env.d.ts` 单行路径变更。该例外要求 Git status 和文件前后内容均精确匹配，任何其他改动都会 fail closed。
3. 真实模式按 upstream `tools/pack` 的 build closure 顺序执行 `pnpm install --frozen-lockfile`、workspace runtime build、Next standalone、web sidecar、daemon native `rebuild better-sqlite3 node-pty`。daemon sidecar 再由 exact Node+pnpm 的 esbuild 构建为 Node 24 ESM bundle，注入 `createRequire` banner，并且只允许 `better-sqlite3`、`node-pty`、`blake3-wasm` 三个 external。metafile 中出现任何其他 package external 会失败；build/rebuild 仍可能读取 registry metadata，不能宣称 offline/hermetic，但 lockfile 和 integrity 保持 fail-closed。
4. daemon closure builder 仅按 production allowlist 复制上述三个 runtime package 的固定文件集、`better-sqlite3` 所需的 `bindings@1.5.0` 与 `file-uri-to-path@1.0.0`，以及供 bundle 动态 package resolution 使用的 app-owned `@open-design/daemon/package.json`。该 metadata 不属于 external allowlist；`blake3-wasm` test helpers/browser runtime 与 `node-pty` Windows JS 均不进入 Darwin closure。输出只含普通文件：source 或 output 的 symlink、hard link、special file、escape、错误平台、缺 native/WASM 或非 `0755` 的 `node-pty` helper 都会失败。普通 build-output normalizer 只处理 Next/web 输出；不再 materialize 或 hoist daemon 的 pnpm dependency graph。随后 copier 只写入 `artifact-policy.json` 的目标路径，继续拒绝任何 symlink、special file 和 hard link，并排除 source map、test/cache/Electron/updater 等内容。
5. resource metadata producer 安全遍历真实 candidate，为每个 native、font、image 和资源目录文件生成 exact artifact/source identity；SBOM producer 用 YAML parser 验证 pinned lock resolution/integrity，并从 staged package manifest 与 NOTICE 文件生成确定性的 SPDX `2.3`。两份 canonical JSON 都写入 artifact，并由 attestation input digest 和 inventory file digest 双重绑定。
6. native inventory 对 staged `better-sqlite3`、`node-pty` 和 `sharp` 的二进制格式、platform、arch、Node ABI、libc 和 producer metadata 做闭包检查。上游 `pnpm.onlyBuiltDependencies` 也必须逐项允许三个 native package；`node-pty` 被 ignored 时立即失败。
7. exact native load 通过后，runner 先生成确定性的 attestation/inventory，以 `O_EXCL` 写入 manifest 并 seal candidate。然后只从该只读 candidate 启动 daemon/web children，smoke 前后均要求 entry bytes/digest 与最终 inventory、daemon closure 一致，并完成 PID、随机端口和 loopback functional smoke。stdout/stderr 使用固定总字节上限并持续 drain。smoke 后再次校验整棵 sealed tree，随后才执行 rights gate 和 atomic publish；smoke 后不得修改 runtime bytes。

真实 staging 的 source、target 和 exact toolchain 都是显式路径；SBOM 与 resource metadata 不接受外部替代文件，只能由 runner 根据 pinned source 和真实 staged closure 生成。owner-only build scratch `--work-parent` 必须与最终 `--staging-root` 的 owner-only publish parent 分离，避免把临时 closure 混入 artifact。

`fixtures/pinned-native-metadata.pending-review.darwin-arm64.json` 来自 pinned upstream 的真实 Node 24 build，只用于验证 exact native load 与后续 smoke。对应 decisions 保持 `review/pending`，因此该 fixture 必须在 inventory rights gate 失败，不能作为 production clearance。

artifact 内的 build attestation 只记录可复现输入、规范化命令、bundle/metafile/external closure、SBOM 和最终 entry digest，不写入 private path、host、PID、port 或 wall-clock time。实际 smoke 的 PID、随机 port、namespace 和时间仅作为 runner 返回的外部 `runEvidence`，不参与 artifact inventory bytes。相同输入在不同 private workspace 和时间构建时，attestation canonical bytes 必须一致。

```sh
cd modules/open-design

# 只输出经全部预检后的命令计划，不执行 build 或写入 staging。
npm run stage:plan -- \
  --source /absolute/path/to/open-design \
  --staging-root /absolute/path/to/staging \
  --work-parent /absolute/path/to/build-scratch-parent \
  --target /absolute/path/to/target.json \
  --node-bin /absolute/path/to/node-24.14.1 \
  --pnpm-bin /absolute/path/to/pnpm-10.33.2.cjs

# 通过相同预检后执行真实 build、copy 和 inventory。
npm run stage -- \
  --source /absolute/path/to/open-design \
  --staging-root /absolute/path/to/staging \
  --work-parent /absolute/path/to/build-scratch-parent \
  --target /absolute/path/to/target.json \
  --node-bin /absolute/path/to/node-24.14.1 \
  --pnpm-bin /absolute/path/to/pnpm-10.33.2.cjs

# 仅供本机开发验收。flag 和环境变量缺一不可；artifact 永久标记为 non-promotable。
SIMULATOR_ALLOW_UNREVIEWED_LOCAL_ARTIFACT=1 npm run stage -- \
  --development-local-only \
  --source /absolute/path/to/open-design \
  --staging-root /absolute/path/to/owner-only-parent/open-design-dev \
  --work-parent /absolute/path/to/build-scratch-parent \
  --target /absolute/path/to/target.json \
  --node-bin /absolute/path/to/node-24.14.1 \
  --pnpm-bin /absolute/path/to/pnpm-10.33.2.cjs
```

Simulator-owned patch 只在 pinned manifest 的 `pnpm.onlyBuiltDependencies` 增加 `node-pty`，其 digest、preimage 和 postimage 全部固定；真实 build 已证明 `node-pty` 与 `better-sqlite3` lifecycle 执行。任何 patch、exact Node、ABI、pnpm executable 或 input digest drift 都会在 build 前停止。

## Issue #87 当前 blocker

public distribution 仍不会在 rights pending 时发布。显式 `development-local-only` 路径只供 owner-only 本地验收，必须同时提供 CLI flag 与环境授权，并在 inventory/attestation 中永久标记 `nonPromotable: true`；public validator 会拒绝该 artifact。不能放宽 symlink policy 或重新引入任意扁平化。

六项 canonical native/WASM redistribution decisions 仍是 `review/pending`，包括 extensionless `node-pty` Mach-O helper 与 `blake3-wasm` Node.js WASM runtime；它们都没有 license/evidence clearance。即使 runtime smoke 后续通过，rights gate 仍必须 fail closed，直到独立法律/provenance 输入完成审核。

## Loopback readiness

artifact 启动后，使用 daemon 直接端点与 web sidecar 的 daemon proxy 共同验收：daemon `/api/health`、daemon `/api/ready`、web `/` 和 web `/api/ready` 都必须成功，且 readiness version 必须一致。脚本只接受 `127.0.0.1` 或 `::1`，不会向非 loopback 地址发请求。

```sh
npm run smoke:loopback -- \
  --daemon-url http://127.0.0.1:7456 \
  --web-url http://127.0.0.1:7457
```
validator 不访问文件系统中的 artifact。`produce-inventory.mjs` 负责安全读取一个已经完成构建和筛选的 staging root：逐级 `lstat`/`realpath` containment，不跟随 symlink，只接受 regular files；打开 descriptor 后以 `fstat` 绑定 identity，流式计算 SHA-256 和 bytes，再检查 descriptor 与路径的 dev/inode/size/mtime/ctime 未变化。hard-link alias、特殊文件、采集期间替换和修改均会失败。

producer 使用 UTF-8 byte order 排序，并拒绝 NFKC + full Unicode case-fold collision。初始安全遍历记录所有目录和 leaf 的 exact path 与 `dev/ino/size/mtimeNs/ctimeNs`；采集完成后再次完整遍历并复核 exact path set、identity 与每个 leaf 的 SHA-256，随后用 confirmation pass 确保已复核文件没有在 final hash traversal 后变化，因此新增、删除、替换或后改文件都会失败。遍历通过 `opendir` 流式累计 entry count，在保存完整单目录列表前执行全局上限。每个 staged leaf 必须被现有 exact/prefix path rule 覆盖。字体、图片、native binary，以及路径含 `plugins`、`skills`、`templates`、`design-templates`、`design-systems` 或 `assets` 的资源必须在 metadata map 中以 artifact exact path 提供资源 metadata；多余路径、未知字段和缺失 metadata 都会 fail closed。生成后 producer 会立即调用同一个 `validateArtifact`，不会输出未验证 inventory。

`artifact-manifest.json` 是 producer 的输出，不得预先出现在 staging root。producer 会合成其 inventory entry，稳定计算 canonical JSON bytes，并按 validator 已定义的 self-digest 规则绑定 inventory。

所有输入会在运行时通过严格 schema，未知字段和未知 enum 会 fail closed。每个 inventory file 都有独立 `schemaVersion`、size 和 SHA-256。required legal/metadata 文件必须是正确 kind 的 regular file；provenance 与 resource metadata digest 绑定 canonical JSON 内容，manifest digest 则绑定“将 `artifact-manifest.json` 自身 `sha256` 置为 64 个 `0` 后”的 canonical inventory，避免自引用循环。SPDX SBOM 还必须绑定固定 media type、schema version、source commit、pinned lock 和 staged package evidence。

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
  --attestation fixtures/minimal-build-attestation.json \
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

producer 只向 stdout 输出 manifest JSON，不接受 `--output` 或任何文件输出路径。这样不会在路径检查后创建文件，消除了该输出写入面的路径替换 TOCTOU；调用方如需保存结果，应在 producer 进程外处理 stdout。CLI 拒绝未知参数、重复参数和缺值参数：

```sh
npm run inventory -- \
  --staging-root /absolute/path/to/staging \
  --metadata /absolute/path/to/metadata.json \
  --target /absolute/path/to/target.json
```

`npm run stage` 是受控的例外：它创建一个全新 staging root，调用 producer 后仅以 `O_EXCL` 创建 artifact manifest，并在写入前绑定 producer 计算的 canonical byte length。不要将 runner 的 staging root、work root 或任何 deploy output 加入 Git。
