# Module Architecture

## 第一切片：Module Contract

`@simulator/module-contract` 是可选 Module 与 Simulator host 之间的 runtime-neutral 边界。它只定义 manifest、lifecycle、capability 和测试 fixture，不负责下载、解压、签名验证、进程管理、Electron 集成或任何真实领域 Module。

该 package 采用 Apache-2.0，与仓库根许可证一致。实现依据 Simulator Issue #55 和 #56 的公开行为要求原创完成。设计与实现过程不读取、不引用、不复制 Proma 或旧 demo 的源代码、注释、fixture、identifier 或 generated output。

## Manifest v1

`schemaVersion: 1` 的 manifest 包含以下字段：

- `id`：3 到 128 字符的 lowercase dotted identifier，例如 `org.simulator.fake`。
- `version`：严格 Semantic Versioning。
- `artifacts`：每个平台一个 artifact，显式声明 `platform`、安全相对 `entrypoint`、HTTPS `url` 和 lowercase SHA-256。
- `capabilities`：去重后的封闭 capability 列表。

v1 支持 `darwin`、`linux`、`win32` 的 `arm64`/`x64` artifact，因此 `artifacts` 最多 6 项；封闭 capability 集合使 `capabilities` 最多 4 项。解析器在枚举或遍历数组前检查数量上限。entrypoint 使用 POSIX 分隔符，必须是 artifact 内的相对路径，不能包含绝对路径、反斜线、空 segment、`.` 或 `..`。

artifact URL 必须与 `new URL(input).href` 完全一致，并且使用 HTTPS、无 credentials、无 fragment、无 control character 或反斜线。origin-only URL 必须保留 canonical 尾斜线，例如接受 `https://modules.example.test/`，拒绝缺少 `/` 的 `https://modules.example.test`；带 path 的 URL 按 `URL.href` 原样 canonical 结果决定是否保留尾斜线。

## Compatibility Policy

解析器对不可信输入执行 fail-closed validation：

- 只接受 plain data object，不执行 accessor。
- 不支持的 `schemaVersion` 立即失败，v1 解析器不会猜测未来 schema。
- 根对象和 artifact 的 unknown field 一律拒绝。未来新增字段必须提升 schema version。
- unknown platform 和 unknown capability 一律拒绝。新增枚举值属于显式 contract 变更。
- validation error 使用固定 `code`、RFC 6901 JSON Pointer `path` 和稳定 `message`；动态 segment 将 `~` 转义为 `~0`、`/` 转义为 `~1`。错误顺序由 schema 顺序、数组顺序及排序后的 unknown field 决定。
- 成功值和失败错误均重建为新对象并 deep-freeze，调用方不能在验证后改变 identity、version、artifact 或 capability。

这种策略牺牲“静默接受新字段”的宽松兼容，换取 host 在安全边界上的确定行为。支持新 schema 需要新增独立解析分支；旧 schema 的既有语义不得原地改变。

## Capability Boundary

第一切片只允许：

- `artifact.read`
- `artifact.write`
- `workspace.read`
- `workspace.write`

这些值只表达最小 host 资源类别，不授予权限；后续 policy 层仍需逐项授权。contract 不提供 host secret、任意 process spawning、approval authority、通用 Electron API 或 vendor/model-specific capability。unknown capability 会被拒绝，因此不能通过自定义字符串扩大权限面。

## Lifecycle

`ModuleRuntime` 定义 `install`、`start`、`health`、`stop` 四个异步且 runtime-neutral 的操作，并使用结构化 result 返回成功或 `INVALID_STATE`。contract 不规定进程、网络、daemon 或 UI 的实现方式。

`FakeModule` 是纯内存 deterministic fixture：

```text
uninstalled -> installed -> running -> stopped -> running
```

非法 transition 不改变 state 或 transition history。`health` 不改变状态，仅在 `running` 时返回 `healthy`。该 fixture 用于验证 contract 和后续 registry；它不是 production module runtime。

## 第二切片：Filesystem Module Installer

`@simulator/module-installer` 是 Issue #60 的 filesystem-only 安装边界。调用方提供已经建立信任的 `VerifiedArtifactDescriptor` 和本地 archive path；installer 会重新验证 descriptor 与 `ModuleManifest` 的一致性、compressed archive SHA-256 和 extracted manifest SHA-256。它不下载文件、不验证 catalog/signature、不启动进程，也不依赖 Electron、daemon、领域 Module 或 Proma。

### Production archive format

当前唯一 production 格式是 `tar.gz`。artifact URL 必须以 `.tar.gz` 结尾，本地文件必须有 gzip magic；zip、plain tar、brotli 和 zstd 均 fail closed。此限制是有意的，避免在第一版同时维护两套高风险 extraction surface。

archive 必须只有一个名为 `module/` 的顶层目录，安装后的版本目录直接包含其内容。entry 只允许 regular file 和 directory；symlink、hardlink、device、FIFO、contiguous/sparse 等特殊类型全部拒绝。v1 path contract 刻意限制为与 Module entrypoint 相同的 safe ASCII segment grammar，即每段必须匹配 `[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?`。同时拒绝 absolute path、drive/UNC、反斜线、colon、control character、`.`/`..`、Windows device name、duplicate 和 ASCII case-fold collision。Unicode path 一律 fail closed，避免声称跨 filesystem/platform 提供并不存在的 full Unicode casefold 等价性。

installer 先用 `O_NOFOLLOW` 打开本地 regular file，复制到 caller root 内唯一的 `0700` staging 并计算 archive hash。只有 hash 匹配后才流式预扫描 raw 512-byte tar headers，验证 checksum、canonical octal size 与双 zero-block 结束标记，并对所有 headers（包括 PAX local/global 与 GNU long-name metadata）执行统一总数限制；metadata payload 另执行累计 byte limit，base-256 size fail closed。之后才运行两遍 `tar`：第一遍只读检查 metadata、entry count、单文件/总大小、depth、path 和 executable policy，第二遍提取到空 staging，并要求观察到完全相同的 entry metadata。raw pre-scan 与 `tar` 都提前执行 decompression-ratio 上限。落盘后再用 `lstat` 遍历全树，拒绝 link/special file，并逐文件计算 SHA-256。

extracted manifest hash 的 canonical input 按 UTF-8 path byte order 全局排序，每条记录以 LF 结尾：

```text
D\t<JSON path>
F\t<JSON path>\t<size>\t<executable 0|1>\t<lowercase sha256>
```

只有 manifest 声明的 entrypoint 可以带 executable bit；archive 中的 entrypoint 必须是带 owner execute bit 的 regular file。extract 后 directory 与 entrypoint mode 统一规范为 `0700`，其他 regular file 统一规范为 `0600`，随后用 `lstat` 与 `X_OK` 再次验证 entrypoint。默认限制为 128 MiB compressed archive、4096 raw headers、64 MiB 单文件、512 MiB extracted total、512 UTF-8 bytes path、32 层 depth、256 KiB metadata 和 200:1 decompression ratio，调用方只能用正的 safe integer 覆盖。

### Activation and recovery

每个 Module 使用不可变 `versions/<version>/` 目录和一个小型 `state.json`。staged payload 与 version 目录位于同一 caller root/filesystem，publish 使用 directory rename；active/LKG 切换使用同目录 temporary file fsync + rename。更新成功后，旧 active 成为 LKG；rollback 原子交换 active/LKG。uninstall 拒绝 active、LKG 和 authoritative usage lease 报告为 in-use 的版本；缺少 `ModuleUsageGuard` 时直接返回 `USAGE_GUARD_REQUIRED`。host/daemon 的 `runExclusive()` 必须阻止新 runtime reference，直到 usage check 与 version-to-trash rename 完成；installer 不接受调用方瞬时 `Set` 快照作为 authority。

首次 journal publish 先写唯一 temporary file、`fsync` file，再以 `transaction.claim/` 的原子 directory create 取得排他发布权，随后 rename 为完整 `transaction.json` 并 `fsync` module directory。普通 write、ENOSPC 或 publish error 会清理 temporary、claim 与已发布 journal，不会留下永久 `BUSY`；claim 前的 crash temporary file 作为无权威 quarantine 保留且不阻塞重试。claim 后的 crash 只有在 host 确认 publisher 已停止后才可用 `recoverInterrupted()` 清除或继续。后续 crash recovery 先把完整 journal 原子 rename 为固定的 `transaction.recovering.json` 取得唯一恢复权，再根据 durable state 判断 rollback 未提交 publish，或完成已经提交的 activation。存在 pending journal 时普通操作返回 `BUSY`；host 启动时应先调用 `recoverAll()`，或针对已知 Module 调用 `recover()`。普通 recovery 看到 claim 或已有 recovering journal 也返回 `BUSY`；只有 host 已确认前一 owner 已停止时，才可显式调用 `recoverInterrupted()`。malformed journal 保留在 recovering 位置并 fail closed，不跟随 journal 中的任意 path。

cancel 只在 state commit 前生效；失败或取消会恢复旧 active/LKG 并清理 staging。state rename 一旦 durable，即视为成功提交，即使随后的 journal cleanup 被中断，recovery 也会保留新 active。

### Archive dependency baseline

实现复用仓库已有 `node-tar`，不调用 shell。2026-07-12 审计发现原 lockfile 的 `tar@7.5.2` 受 `GHSA-34x7-hfp2-rc4v`、`GHSA-8qq5-rm4j-mr97`、`GHSA-83g3-92jg-28cx`、`GHSA-qffp-2rhf-9h96`、`GHSA-9ppj-qmqm-q256`、`GHSA-vmf3-w455-68vh` 和 `GHSA-r6q2-hw4h-h46w` 影响，因此直接依赖与 lockfile 提升到 `tar@7.5.20`。installer 仍不把 library 默认防护当成唯一边界：双遍验证、禁 link、落盘复核和 limits 都由 package 自己执行。
