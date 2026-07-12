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

## 第二切片：Deterministic Module Registry

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
