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

## Filesystem Module Installer

`@simulator/module-installer` 是 Issue #60 的 filesystem-only 安装边界。调用方提供已经建立信任的 `VerifiedArtifactDescriptor` 和本地 archive path；installer 会重新验证 descriptor 与 `ModuleManifest` 的一致性、compressed archive SHA-256 和 extracted manifest SHA-256。它不下载文件、不验证 catalog/signature、不启动进程，也不依赖 Electron、daemon、领域 Module 或 Proma。

### Production archive format

当前唯一 production 格式是 `tar.gz`。artifact URL 必须以 `.tar.gz` 结尾，本地文件必须有 gzip magic；zip、plain tar、brotli 和 zstd 均 fail closed。此限制是有意的，避免在第一版同时维护两套高风险 extraction surface。

archive 必须只有一个名为 `module/` 的顶层目录，安装后的版本目录直接包含其内容。entry 只允许 regular file 和 directory；symlink、hardlink、device、FIFO、contiguous/sparse 等特殊类型全部拒绝。v1 path contract 刻意限制为与 Module entrypoint 相同的 safe ASCII segment grammar，即每段必须匹配 `[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?`。同时拒绝 absolute path、drive/UNC、反斜线、colon、control character、`.`/`..`、Windows device name、duplicate 和 ASCII case-fold collision。Unicode path 一律 fail closed，避免声称跨 filesystem/platform 提供并不存在的 full Unicode casefold 等价性。

installer 先在 caller root 内建立唯一的 `0700` staging，并在任何 archive 工作前 durable 写入严格的 `ownership.json`；随后用 `O_NOFOLLOW` 打开本地 regular file，复制到 staging 并计算 archive hash。只有 hash 匹配后才流式预扫描 raw 512-byte tar headers，验证 checksum、canonical octal size 与双 zero-block 结束标记，并对所有 headers 执行统一总数限制。node-tar 识别的 `g/x/X/L/K/N` metadata payload 全部计入累计 byte limit，base-256 size fail closed。之后才运行两遍 `tar`：第一遍只读检查 metadata、entry count、单文件/总大小、depth、path 和 executable policy，第二遍提取到空 staging，并要求观察到完全相同的 entry metadata。raw pre-scan 与 `tar` 都提前执行 decompression-ratio 上限。落盘后再用 `lstat` 遍历全树，拒绝 link/special file，并逐文件计算 SHA-256。

extracted manifest hash 的 canonical input 按 UTF-8 path byte order 全局排序，每条记录以 LF 结尾：

```text
D\t<JSON path>
F\t<JSON path>\t<size>\t<executable 0|1>\t<lowercase sha256>
```

只有 manifest 声明的 entrypoint 可以带 executable bit；archive 中的 entrypoint 必须是带 owner execute bit 的 regular file。extract 后 directory 与 entrypoint mode 统一规范为 `0700`，其他 regular file 统一规范为 `0600`，随后用 `lstat` 与 `X_OK` 再次验证 entrypoint。默认限制为 128 MiB compressed archive、4096 raw headers、64 MiB 单文件、512 MiB extracted total、512 UTF-8 bytes path、32 层 depth、256 KiB metadata 和 200:1 decompression ratio，调用方只能用正的 safe integer 覆盖。

### Activation and recovery

每个 Module 使用不可变 `versions/<version>/` 目录和一个小型 `state.json`。staged payload 与 version 目录位于同一 caller root/filesystem，publish 使用 directory rename；active/LKG 切换使用同目录 temporary file fsync + rename。更新成功后，旧 active 成为 LKG；rollback 原子交换 active/LKG。uninstall 拒绝 active、LKG 和 authoritative usage lease 报告为 in-use 的版本；缺少 `ModuleUsageGuard` 时直接返回 `USAGE_GUARD_REQUIRED`。host/daemon 的 `runExclusive()` 必须阻止新 runtime reference，直到 usage check 与 version-to-trash rename 完成；installer 不接受调用方瞬时 `Set` 快照作为 authority。

首次 journal publish 先写唯一 temporary file、`fsync` file，再以 `transaction.claim/` 的原子 directory create 取得排他发布权，随后 rename 为完整 `transaction.json` 并 `fsync` module directory。普通 write、ENOSPC 或 publish error 会清理 temporary、claim 与已发布 journal，不会留下永久 `BUSY`；claim 前的 crash temporary file 作为无权威 quarantine 保留且不阻塞重试。claim 后的 crash 只有在 host 确认 publisher 已停止后才可用 `recoverInterrupted()` 清除或继续。后续 crash recovery 先把完整 journal 原子 rename 为固定的 `transaction.recovering.json` 取得唯一恢复权，再根据 durable state 判断 rollback 未提交 publish，或完成已经提交的 activation。存在 pending journal 时普通操作返回 `BUSY`；host 启动时应先调用 `recoverAll()`，或针对已知 Module 调用 `recover()`。普通 recovery 看到 claim 或已有 recovering journal 也返回 `BUSY`；只有 host 已确认前一 owner 已停止时，才可显式调用 `recoverInterrupted()`。malformed journal 保留在 recovering 位置并 fail closed，不跟随 journal 中的任意 path。

cancel 只在 state commit 前生效；失败或取消会恢复旧 active/LKG 并清理 staging。pre-journal crash 产生的 staging 没有 transaction journal authority：`recoverAll()` 在完成 journal recovery 后，只清理 UUID 与 ownership marker 严格匹配、marker 至少 24 小时、且对应 Module 不存在 journal/recovering journal/claim 的 stale staging。fresh、future-dated、malformed 或未知 entry 保持 quarantine；同实例 active mutation 会使 `recoverAll()` 返回 `BUSY`。该 bounded-age policy 不替代跨进程 locking，host 必须在停止该 root 的其他 installer owner 后于 startup 调用。state rename 一旦 durable，即视为成功提交，即使随后的 journal cleanup 被中断，recovery 也会保留新 active。

### Archive dependency baseline

实现复用仓库已有 `node-tar`，不调用 shell。2026-07-12 审计发现原 lockfile 的 `tar@7.5.2` 受 `GHSA-34x7-hfp2-rc4v`、`GHSA-8qq5-rm4j-mr97`、`GHSA-83g3-92jg-28cx`、`GHSA-qffp-2rhf-9h96`、`GHSA-9ppj-qmqm-q256`、`GHSA-vmf3-w455-68vh` 和 `GHSA-r6q2-hw4h-h46w` 影响，因此直接依赖与 lockfile 提升到 `tar@7.5.20`。installer 仍不把 library 默认防护当成唯一边界：双遍验证、禁 link、落盘复核和 limits 都由 package 自己执行。
## Module Release Trust

`@simulator/module-release-trust` 是 runtime-neutral 的 signed catalog 验证边界。它只使用调用方提供的 envelope、trusted public key set、当前时间和 monotonic sequence high-water mark；不包含 network、filesystem、downloader、Electron 或 process 能力，也不保存私钥、seed 或持久状态。

### Signed Envelope 与 Canonical Bytes

v1 envelope 明确携带 `keyId`、原始 `catalogBytes` 和 64-byte Ed25519 `signature`。验证器复制输入 bytes 后，直接对收到的原始 catalog bytes 验签；它不会 parse 后重序列化并用另一组 bytes 验签。签名通过后，bytes 还必须是严格 UTF-8、合法 JSON，并与该 JSON 的 deterministic canonical representation 完全一致。因此 whitespace、field order、duplicate/ambiguous representation 或任意 byte mutation 都不能跨过 trust boundary。

canonical encoder 只接受 data-only plain object 和 dense plain array；拒绝 accessor、symbol、sparse array、额外 array property、循环引用、unsafe number 和 non-JSON value。固定 byte、depth 和 value-count 上限在验签边界限制 CPU 与 memory 消耗。

Production API 只接受 32-byte Ed25519 public key。package 不提供 signing API，也不包含 private key 或 seed；测试使用运行时生成、明确 test-only 的内存 key pair。另有一个由 Python `cryptography` 独立生成的固定 interoperability vector，仓库只保存 public key、canonical catalog bytes 和 signature，并覆盖 catalog/signature bit flip。

### Catalog v1

catalog 包含递增的 positive safe-integer `sequence`、canonical ISO-8601 `issuedAt` / `expiresAt` 和 release 列表。每个 release 复用 `@simulator/module-contract` 的完整 manifest validator，并为 manifest 的每个平台 artifact 声明 positive safe-integer byte size。module ID + version、manifest platform 和 size platform 均不得重复；size platform 必须与 manifest artifacts 一一对应。

manifest validator 继续负责 lowercase SHA-256、canonical absolute HTTPS URL、safe entrypoint、known platform/capability 及 deep immutability。trust package 重建并 deep-freeze catalog、release、manifest 和 size metadata，调用方不能在验签后修改 hash、size、URL 或 identity。

### Trust 与 Rollback Policy

trusted key 由唯一 `keyId`、public key、`activeFrom`、可选 `activeUntil` 和可选 `revokedAt` 构成，key set 最多 64 项。catalog 的 `issuedAt` 必须落在 key activation window 内且早于 revocation；`expiresAt` 不得越过 `activeUntil` 或已知的 `revokedAt`。无论 catalog 何时签发，只要 trusted `now >= revokedAt` 就立即返回 `KEY_REVOKED`；`now >= activeUntil` 同样停止接受该 key。

catalog lifetime 最多 24 小时。当前时间必须位于 catalog issuance/expiry window，调用方可提供最多 5 分钟的 non-negative `clockSkewMs`；clock skew 不延迟 key revocation。options、trusted key entry、state 都按 unknown plain-data input 验证，null、accessor、proxy、sparse/oversized key set 返回结构化 diagnostic 而不执行 getter 或抛出异常。

调用方必须原子持久化 `highestSequence` 和 `latestIssuedAt`；初始 state 为 `{ highestSequence: 0 }`，第一次成功后两者必须成对存在。sequence 小于或等于 high-water mark 时返回 `ROLLBACK_DETECTED`，`issuedAt` 未严格推进时返回 `BACKDATED_CATALOG`，因此 backdated catalog 不能用超高 sequence 污染 rollback state。package 自身不通过 filesystem 隐式持久化。所有失败均返回固定 `code`、阶段 `stage`、RFC 6901 风格 `path`、稳定 `message` 和适用时的 `keyId`。

## Verified Catalog / Artifact Downloader

`@simulator/module-downloader` 负责把不可信 HTTPS 响应转换成经过验证、可原子发布的 catalog 与 artifact cache 记录。package 依赖 `@simulator/module-release-trust`，但 network、clock 和 cache 都由调用方通过 adapter 注入；它不包含 installer、archive extraction、Electron、daemon、process、UI 或真实领域 Module。

### Catalog Wire 与原子信任状态

catalog endpoint 返回严格 JSON envelope，字段固定为 `schemaVersion`、`keyId`、canonical padded base64 `catalogBytes` 和 `signature`。下载器对完整响应设置 timeout 和 byte 上限，保存收到的 envelope 原字节，decode 后把原始 `catalogBytes` 与 signature 交给 `verifyModuleReleaseCatalog`。它不会 parse catalog 后重新序列化为另一组待验证 bytes。

verified catalog、ETag、expiry 和 verifier 返回的 monotonic trust state 先作为完整 staged record 写入，再由 cache adapter 原子 publish。所有使用同一 backing store 的 adapter 实例必须共享 `catalog` lease；publish 还必须以先前 committed trust state 执行 CAS，使错误的 lease 实现也不能让 stale verifier result 覆盖更高 high-water mark。启动恢复会重新 decode 和验签 staged 原字节，并核对 staged expiry/trust metadata；只有完整匹配且 CAS 成功才 publish，损坏或不可信 stage 会被丢弃。若 crash 发生在 publish 后、stage 清理前，恢复通过 byte 与 trust-state equality 识别已提交事务并只清理 stage。

`304 Not Modified` 仅在同一 catalog URL 存在重新验签成功且按注入 clock 尚未过期的 exact cached response 时接受。无 cache、cache 损坏、key 已失效或 catalog 已过期时，`304` fail closed。fresh `200` 必须通过当前 committed high-water mark 验证，防止 rollback/backdating。

### HTTPS 与 Redirect Policy

初始 catalog URL、artifact manifest URL、每个 fetch adapter 报告的最终 URL和每个 redirect target 都必须是 canonical HTTPS URL，且不能含 credentials 或 fragment。fetch adapter 必须使用 manual redirect；若 adapter 隐式跟随，下载器拒绝响应。redirect 仅允许保持初始 origin，限制 hop 数，跨 origin、降级协议或 malformed `Location` 均 fail closed。

fetch response 明确携带 `dispose()` ownership contract。redirect intermediate response 由 redirect loop dispose；交给 catalog/artifact caller 的最终 response 无论正常完成、`304`、non-2xx、declared oversize、invalid Range、body error、timeout 或 cancellation，都在 `finally` 中 exactly-once dispose。body iterator 不需要自行响应 `AbortSignal`；下载器把每次 `next()` 与 timeout/cancel signal race，并把 iterator error 映射为 retryable `NETWORK_ERROR`、timeout 映射为 retryable `TIMEOUT`。

### Artifact Streaming、Resume 与并发

artifact 使用 verified catalog 中的 SHA-256 和平台 byte size作为发布条件。下载过程中逐 chunk 写 unique partial、检查累计 size、验证 `Content-Length`，完成后从 cache adapter 重新流式读取 partial 计算 SHA-256；size 与 hash 都匹配后才能原子 publish。hash mismatch 会删除 poisoned partial。

续传是可选优化：只有 partial 的 URL、hash、expected size 全匹配并持有 strong ETag 时，才发送 `Range` 与 `If-Range`。服务端必须返回 `206`、精确 `Content-Range`、相同 strong ETag 和正确剩余 `Content-Length`；任一不匹配都会删除 partial，并按 retry policy 从 byte zero 重试。weak/no validator partial 不会续传。启动时按注入 clock 清理超过 age policy 的 stale partial。

同一 downloader 实例内，相同 hash 的并发请求共享一个 flight；所有使用同一 backing store 的 downloader/cache adapter 实例还必须共享 `artifact:<sha256>` lease，因此第二实例等待后只读取第一个 winner，不会并发删除或发布同一 partial。artifact publish 是 compare-absent 原子操作，CAS loser 读取并校验 winner。URL 或 expected size 冲突不会在实例内合并。

每个 caller 独立接收 progress 和 cancellation，pre-aborted request 在 initialization、flight、lease 和 fetch 前失败；只有最后一个 subscriber 取消才终止共享 transfer。progress 使用整个 flight 的 byte high-water mark，Range fallback 或 retry 从 byte zero 开始时不会倒退。retry 只处理 timeout、network、明确 retryable HTTP status 和可安全重启的 Range/size 中断，backoff 由注入 clock 执行。terminal failure 删除当前 partial；初始化与每次下载都按 age 和 per-artifact count 上限清理 partial，并在 artifact lease 内只保留 newest safe-resume candidate。

测试用 `FilesystemModuleDownloaderCache` 使用 temp directory、atomic file/directory rename 和跨 adapter 实例 lease 模拟接近 filesystem 的事务语义；它只用于 adapter conformance，不是 production cache adapter。
## Deterministic Module Registry

`@simulator/module-registry` 是可选 Module 的 runtime-neutral metadata source of truth。它依赖 `@simulator/module-contract` 和仓库已有的 `semver`，不依赖 filesystem、network、archive、process、Electron、React 或任何领域 Module。内置 Agent workspace 不读取该 registry，因此 optional-module state 为空、损坏或不兼容时不会阻塞 Agent。

### Validated Input Boundary

Registry 的 `install` 只接受当前进程中由 `parseModuleManifest` 返回的 immutable manifest。`module-contract` 使用不可伪造的运行时 provenance 记录成功产物；手工构造、类型强转或仅做 `Object.freeze` 的对象会得到 `UNVALIDATED_MANIFEST`，未知 schema 会得到 `UNSUPPORTED_MANIFEST_SCHEMA`。snapshot 中的 manifest 是 immutable canonical copy，不会泄漏 registry 内部引用，也不会被当成新的 validated input。

Manifest v1 已在第一切片冻结，且不包含 host version range。为避免原地改变 schema v1，安装方把 `hostVersionRange` 作为独立 compatibility declaration 与 validated manifest 一起提交。Registry 使用构造时固定的 canonical host SemVer 和 `ModulePlatform` 做两项检查：

- manifest 必须包含当前 platform 的 artifact；
- 当前 host version 必须满足规范化后的 Semantic Version range。

当前 host 不兼容的安装请求失败且不改变状态。若同一份已提交状态在不同 host version/platform 下恢复，已安装版本会保留并标记为 `incompatible`，但不兼容的 active/LKG 引用会被清除并产生 deterministic recovery diagnostics。

### State And Ordering

每个 Module 记录所有 installed versions、一个 optional active version、一个 optional last-known-good (LKG) version 和 module-level disabled 状态。核心 invariant 是：

- active 与 LKG 必须引用同一 Module 中已安装且与当前 host 兼容的版本；
- disabled Module 保留选择状态，但在 re-enable 前不能执行新的 activation；
- 删除 active 或 LKG 版本必须在同一个 API mutation 中显式提供替代版本或 `null`；
- duplicate 表示相同 ID/version、canonical manifest 和 host range 均相同；任一内容不同则为 conflict；
- 失败 mutation 始终返回之前的 immutable snapshot，不修改 registry 或 committed persistence。

Snapshot 按 Module ID 的二进制字典序排列，version 按 SemVer precedence、build metadata、原始字符串依次稳定排序。Manifest 内 artifact 按 platform 排序，capability 按字符串排序。Diagnostics 按 code、Module ID、version、message 排序。因此相同输入集合不受安装顺序、Map insertion order 或原始 manifest 数组顺序影响。

### Atomic Persistence And Recovery

`ModuleRegistryPersistence` 只定义同步 `read` 与 `commit`，不包含 filesystem API。生产级磁盘 persistence 不在本切片范围。随 package 提供的 `InMemoryModuleRegistryPersistence` 使用 committed/staged 两份 plain-data state：

```text
previous committed -> stage complete next state -> publish committed -> clear staged
```

Registry mutation 先 copy-on-write 构造 next state，再交给 persistence commit；只有 commit 成功后才发布新的内存 state。测试 adapter 可以在 stage 后、publish 前 deterministic interrupt。重启时 registry 忽略 staged state，只恢复 previous committed snapshot，并报告 `RECOVERY_INTERRUPTED_COMMIT`。

Persisted state schema、plain-data shape、manifest、Module identity、version uniqueness、host range 与 active/LKG references 会在恢复时重新验证。任一 corrupt/conflicting state 都 fail safe 为 empty optional-module registry，并只报告 `CORRUPT_PERSISTED_STATE`。`RegistryCrashRecoveryFixture` 同时持有独立且 immutable 的 built-in Agent availability state，用于证明 registry corruption 和 interrupted commit 不会传播到内置 Agent。
