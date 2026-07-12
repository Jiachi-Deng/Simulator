# Module Host Bridge Contract

本 package 定义 optional module 向 trusted host 请求特权操作时使用的 runtime-neutral contract、capability policy 与 deterministic fakes。本批只建立安全边界和状态机，不包含真实 transport 或操作执行器。

## 威胁模型

module renderer 与 module process 均按不可信输入处理。攻击者可能伪造 envelope、重放 request、跨 module/process 使用 token、提交过深或过大的 JSON、利用 symlink 逃出 workspace、探测 credential inventory，或在 approval 取消、超时及 process crash 后继续提交结果。

bridge 采用以下 fail-closed 约束：

- request、response、event 都携带 `schemaVersion` 与固定 envelope 字段；未知 version、字段、method、error code、event kind 会被拒绝。
- 仅接受 plain JSON，并限制 UTF-8 bytes、深度、node 数、单个 string、object keys、audit history 与 replay entries。
- capability token 必须来自注入的 cryptographically secure `EntropySource`，固定为 256-bit opaque token；内部只保存注入式 `TokenHasher` 的 hash。生产 adapter 必须使用抗碰撞的 cryptographic hash，testing fake 不可用于生产。
- capability 绑定 `moduleId`、`processId`、workspace canonical/real root、allowed methods、expiry、`maxUses` 与 nonce。所有消费在 bridge 内串行提交，单次 token 的并发请求最多一个成功。
- renderer path 从不直接参与授权判断。`PathAuthority` 必须由 trusted host 实现 canonicalization、realpath 与 path containment；bridge 使用 realpath 检查 workspace 边界，并拒绝 filesystem root、host data root 与 module data root。
- replay identity 覆盖 method、module、process、session、turn、token、request 与 payload。相同 identity 返回缓存 response；相同 request id 的其他 identity 被拒绝。
- credential contract 只接收 opaque `credentialHandle`、operation 与 operation arguments，不提供 secret value 或 credential inventory。audit 与 snapshot 不记录 handle、arguments、token、nonce、path 或 approval prompt。
- approval 绑定 module/process/session/turn/request。module 只能创建请求，不能提交 decision；只有注入的 `TrustedApprovalResolver` 可以完成。cancel、timeout 或 process restart 后到达的 resolver 结果会被忽略。
- 支持 module、process、all 与 crash/restart revoke；audit 是 bounded、结构化且经过最小化处理的 event stream。

`host-agent.opaque` 是预留的 versioned opaque descriptor。本版本默认返回 `UNSUPPORTED_CAPABILITY`，不会把未知内容转交给 host。

## 公开入口

- `ModuleHostBridge.grant()`：由 trusted host 签发 capability。
- `ModuleHostBridge.handle()`：解析 request、执行 policy，并返回授权结果；它不执行真实 host side effect。
- `revokeModule()`、`revokeProcess()`、`revokeAll()`、`restartProcess()`、`sweepExpired()`：管理 lifecycle。
- `parseRequestEnvelope()`、`parseResponseEnvelope()`、`parseEventEnvelope()`：严格 contract parser。
- `@simulator/module-host-bridge/testing`：fake clock、entropy、path authority、audit sink 与 approval resolver。

## 本批明确不包含

- HTTP、WebSocket、Electron IPC 或其他 transport
- filesystem picker/export、external URL、OAuth、notification、artifact publish 的真实执行器
- Keychain、credential storage、secret retrieval 或 credential inventory
- host-agent integration
- 持久化 replay/audit storage；当前 store 是 bounded in-memory policy state，process restart 时需由上层建立新的 bridge 并撤销旧 process authority

因此，上层接入时必须在 trusted host transport 边界再次绑定真实 module process identity，不能仅信任 envelope 中的 `moduleId` 或 `processId`。
