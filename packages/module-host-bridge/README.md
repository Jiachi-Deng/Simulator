# Module Host Bridge Contract

本 package 定义 optional module 向 trusted host 请求特权操作时使用的 runtime-neutral contract、capability policy 与 deterministic fakes。本批只建立安全边界和状态机，不包含真实 transport 或操作执行器。

## 威胁模型

module renderer 与 module process 均按不可信输入处理。攻击者可能伪造 envelope、重放 request、跨 module/process 使用 token、提交过深或过大的 JSON、利用 symlink 逃出 workspace、探测 credential inventory，或在 approval 取消、超时及 process crash 后继续提交结果。

bridge 采用以下 fail-closed 约束：

- request、response、event 都携带 `schemaVersion` 与固定 envelope 字段；未知 version、字段、method、error code、event kind 会被拒绝。
- transport 应调用 `handleRaw()`；它在 `JSON.parse` 前依次限制原始 bytes、验证 UTF-8、拒绝解码后重复的 JSON object key，再进入 plain JSON 的深度、node 数、单个 string 与 object keys 限制。`handle()` 是仅供 host 内部已解析对象使用的 trusted-object API，不应直接暴露给 IPC/HTTP/WebSocket 输入。
- capability token 必须来自注入的 cryptographically secure `EntropySource`，固定为 256-bit opaque token；内部只保存注入式 `TokenHasher` 的 hash。生产 adapter 必须使用抗碰撞的 cryptographic hash，testing fake 不可用于生产。
- capability descriptor kind 与唯一的 `allowedMethods` 项必须是 canonical supported method 且严格相同。grant 和 capability 绑定 trusted principal 的 `ownerId`/`moduleId`/`processId`、workspace canonical/real root、expiry、`maxUses` 与 request 必须回传的 nonce。envelope 自报 module/process identity 会被 `TrustedTransportContext` 覆盖。
- renderer path 从不直接参与授权判断。`PathAuthority` 必须由 trusted host 实现 canonicalization、realpath 与 path containment；bridge 使用 realpath 检查 workspace 边界，并拒绝 filesystem root、host data root 与 module data root。成功响应同时返回 authority 给出的 `canonicalPath` 与 `realPath`，两者不可互相替代。
- production `PathAuthority` 必须明确实现 Windows drive/UNC、目标平台 case sensitivity、nonexistent leaf、symlink ancestor 与 TOCTOU contract。testing fake 只提供 deterministic contract modeling，不能替代 production filesystem primitives。
- replay identity 覆盖 method、完整 trusted principal、session、turn、token、nonce、request 与 payload。每个 principal 有独立容量，返回 replay 前会重新检查 expiry、revoke 与 process generation；response 用 `replayed` 明示结果。只会回收 capability 已失效且关联 approval/receipt 已终态的 identity，执行中的 receipt 不会被回收。非 approval 授权创建 `authorized -> executing -> committed|failed` execution receipt，adapter 只有成功 claim `authorized` receipt 后才能执行 side effect。
- credential contract 只接收 opaque `credentialHandle`、operation 与 operation arguments，不提供 secret value 或 credential inventory。注入的 `CredentialAuthority` 必须同时验证 handle owner、module、process 与 operation。audit 与 snapshot 不记录 handle、arguments、token、nonce、path 或 approval prompt。
- `external.open` 与 `oauth.launch` 必须经过注入的 `URLAuthority` scheme/origin policy，只把 authority 返回的 normalized URL 交给 host adapter。
- approval 绑定 capability token hash/generation 与完整 trusted principal、session、turn、request。module 只能创建请求，不能提交 decision；只有注入的 `TrustedApprovalResolver` 可以完成。cancel、timeout、capability expiry、revoke 或 process restart 后到达的 resolver 结果会被忽略。
- module、process、all 与 crash/restart revoke，以及 expiry sweep，都会同步取消关联 pending approvals；late resolver 结果不能恢复为 approved。audit history 与 forwarding queue 都有界，sink 有 timeout、failure isolation 和独立 drain，不参与全局 policy tail。

`host-agent.opaque` 是预留的 versioned opaque descriptor。本版本默认返回 `UNSUPPORTED_CAPABILITY`，不会把未知内容转交给 host。

## 公开入口

- `ModuleHostBridge.grant()`：由 trusted host 为完整 principal 签发 capability，输入必须包含 `ownerId`、`moduleId` 与 `processId`。
- `ModuleHostBridge.handleRaw()`：面向 untrusted transport bytes 的入口；先做 raw limits 再解析。
- `ModuleHostBridge.handle()`：仅供 trusted host 内部对象调用，仍执行严格 schema policy；它不执行真实 host side effect。
- `claimExecution()`、`completeExecution()`：由 trusted host adapter 原子 claim/提交 execution receipt，防止 replay 重复 side effect。
- `revokeModule()`、`revokeProcess()`、`revokeAll()`、`restartProcess()`、`sweepExpired()`：管理 lifecycle。
- `parseRequestEnvelope()`、`parseResponseEnvelope()`、`parseEventEnvelope()`：严格 contract parser。
- `@simulator/module-host-bridge/testing`：fake clock、entropy、path authority、audit sink 与 approval resolver。

## 本批明确不包含

- HTTP、WebSocket、Electron IPC 或其他 transport
- filesystem picker/export、external URL、OAuth、notification、artifact publish 的真实执行器
- Keychain、credential storage、secret retrieval 或 credential inventory
- host-agent integration
- 持久化 replay/audit storage；当前 replay state 在每个 trusted principal 内有界，process restart 时需由上层建立新的 bridge 并撤销旧 process authority

因此，上层接入时必须在 trusted host transport 边界再次绑定真实 module process identity，不能仅信任 envelope 中的 `moduleId` 或 `processId`。
