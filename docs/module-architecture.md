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

## 第二切片：Module Daemon Manager

`@simulator/module-daemon` 是 host-neutral 的可选 Module 进程 supervisor。它依赖 `@simulator/module-contract` 选择当前平台声明的 artifact，但不包含 Electron/React、installer/downloader、catalog network、Host Agent API、领域 adapter 或 sandbox/container 逻辑。

### Activation Boundary

调用方必须传入已激活 Module version 的 absolute root。Manager 对 root 与 manifest entrypoint 执行 `realpath`，拒绝解析到 root 外的 symlink、目录、缺失文件以及 POSIX 上不可执行的文件。启动请求固定为：

- executable：校验后的 activated-root entrypoint。
- args：空数组。
- cwd：canonical activated root。
- `shell: false`。
- env：调用方显式提供的 minimal base env，加上 `SIMULATOR_MODULE_ID`、`SIMULATOR_MODULE_VERSION`、`SIMULATOR_MODULE_HEALTH_HOST`、`SIMULATOR_MODULE_HEALTH_PORT`。不会继承 host `process.env`；Module 也不能覆盖这四个 host-owned 值。

activated root 必须由 installer 作为 immutable activation 管理；Manager 不承担下载、解压、签名校验或可写 root 的并发变更防护。

### Health Protocol And Endpoint Allocation

每次 launch 都向 OS 请求一个新的 `127.0.0.1:0` ephemeral endpoint，释放 reservation 后把实际 port 传给 daemon。Manager 拒绝 `0.0.0.0`、LAN 地址、hostname 和无效 port；restart 会重新分配 endpoint，不复用固定 port。

daemon 必须在 `/health` 返回 HTTP 2xx、`Content-Type: application/json`，且 body 精确符合：

```json
{"status":"healthy"}
```

连接失败在 startup window 内会 bounded retry；格式错误 fail closed。运行期连续失败先进入 `degraded`，达到 threshold 后清理当前 process tree 并按 restart policy 处理。单次 probe 与整体 startup 分别有独立 timeout。

### Lifecycle And Supervision

Manager 对每个 Module ID 跟踪 `starting`、`healthy`、`degraded`、`stopping`、`stopped`、`crashed`，并输出带稳定 code、timestamp 和 restart count 的 diagnostic。状态转换由每个 Module 唯一的 supervisor loop 串行驱动：

```text
starting -> healthy <-> degraded
starting|healthy|degraded -> crashed -> backoff -> starting
starting|healthy|degraded|crashed -> stopping -> stopped
```

startup failure、unexpected exit 和 health threshold failure 共用有限 restart budget；backoff 取 bounded schedule 的最后一个值封顶，不会无限增长或无限 restart。budget 耗尽后稳定停在 `crashed`。`touch(id)` 更新活动时间，超过 idle timeout 会清理后进入 `stopped`，不消耗 restart budget。

同一 activated version 的 concurrent start 会合并为一个 Promise，canonical root alias 也会归并；restart backoff 中的 start 会等待原 supervisor 恢复，不会创建第二条 lifecycle。不同 root/version 不会覆盖 active process。explicit stop、health probe 中 stop、backoff 中 stop 和重复 stop 都是 race-safe/idempotent。`drain()` 原子地拒绝后续 start，并等待所有已登记 daemon 完成 process-tree cleanup，供 app quit 使用。状态 subscriber 的异常与 supervisor 隔离，可通过 `onListenerError` 上报。

POSIX real process adapter 使用独立 process group，先向整组发送 `SIGTERM`，等待整组退出，grace timeout 后才发送 `SIGKILL`。Windows 使用原生 Job Object：declared entrypoint 以 `CREATE_SUSPENDED` 创建，先加入启用 `KILL_ON_JOB_CLOSE` 的 Job 后才 resume，因此 leader 提前 crash 或 app 异常退出都不会让 descendants 脱离 ownership；stop 通过 `TerminateJobObject` 与 active-process accounting 做有界 drain。Windows native FFI 保持在动态 chunk，非 Windows 不加载。deterministic fake process/clock/health adapters 从 `@simulator/module-daemon/testing` 导出。真实本地 fixture 在 package test 中执行 20 次 start/health/stop，并逐轮确认 parent 与 descendant PID 都已退出；POSIX 还验证 descendant graceful handler，Windows CI 另覆盖 leader-first crash 后的 descendant cleanup。
