# TurboFlux 用户资料包容器格式 v1

本文公开说明 `.turboflux-profile` 容器 v1 的互操作与安全边界。容器版本与组件版本独立：容器 v1 可以承载 `conversations` 组件 v1 或 v2。内部资料目录不是协议；兼容实现必须按本格式解析，不能直接压缩或覆盖 `~/.turboflux`。

## 文件标识

- 扩展名：`.turboflux-profile`
- MIME：`application/vnd.turboflux.profile`
- Magic：ASCII `TURBOFLUXPROFILE`（16 字节）
- Container Version：无符号 16 位整数 `1`
- Manifest Schema Version：`1`

## 容器布局

| 偏移 | 长度 | 内容 |
| --- | ---: | --- |
| 0 | 16 | Magic |
| 16 | 2 | Container Version，大端序 |
| 18 | 2 | Flags；bit 0 表示加密，其余位必须为 0 |
| 20 | 4 | Canonical JSON Header 长度，大端序 |
| 24 | 8 | Payload 长度，大端序 |
| 32 | 可变 | Canonical JSON Header |
| 后续 | 可变 | gzip Payload；可选 AES-256-GCM 密文 |
| 末尾 | 16 或 32 | 加密包为 GCM Tag；未加密包为 Payload SHA-256 |

Header 只允许公开容器版本、压缩算法、加密状态、KDF 参数、随机 Salt、Nonce 与 Tag 长度。资料名称、组件、工作区和秘密不得出现在 Header。

## 加密

- KDF：Node `scrypt`，`N=32768`、`r=8`、`p=1`、Key 32 字节、Salt 16 字节、`maxmem=64 MiB`。
- Cipher：AES-256-GCM，Nonce 12 字节，Tag 16 字节。
- AAD：Prelude 的前 24 字节加完整 Canonical Header。
- 密码只在当前操作的短生命周期内存中存在；成功、失败和取消后覆盖相关 Buffer。
- 认证失败统一返回“密码错误或资料包损坏”，不泄露更细的解密状态。
- 选择 Credentials 时必须加密整个资料包；不存在“只加密某个组件”的模式。

## Payload 与条目

解密和 gunzip 后是顺序条目流。每项由 `pathLength:uint32`、`size:uint64`、`sha256:32 bytes`、UTF-8 路径和文件内容组成；`pathLength=0` 表示结束。

路径必须是 NFC 规范化的相对 POSIX 路径。实现必须拒绝绝对路径、`..`、NUL、Windows 驱动器/UNC/设备名、大小写或 Unicode 折叠碰撞、重复条目、符号链接和硬链接语义。每项必须在物化前后校验长度和 SHA-256。

## Manifest

`manifest.json` 是必需首要领域文档，包含：

- 随机 `archiveId` 和导出时间；
- 应用、Core、平台与资料存储版本；
- 来源资料 ID（只作审计，导入时不会成为本地 ID）和显示名称；
- 组件 ID、Schema Version、条目数、逻辑字节、Blob 数、敏感级别和依赖；
- 虚拟化后的 Workspace ID 与不含绝对路径的来源提示；
- `conversationDataVersion`；版本为 2 时必须包含 Event 分段数量、事件总数、投影重建策略和迁移来源；
- Manifest 自身的确定性内容摘要。

JSON 文本统一 NFC，键按确定性顺序序列化。未知必需组件、更高容器版本或缺失迁移链必须拒绝；未知非必需展示字段可以忽略。

## Conversations 组件

### 组件 v1

`components/conversations/index.json` 的 `schemaVersion` 为 1，每个索引项引用 `components/conversations/items/<conversationId>.json`。这是 Legacy Recovery 兼容输入，不是 Conversation V2 的事实源。

### 组件 v2

V2 采用显式索引和每会话 Event 分段：

```text
components/conversations/index.json
components/conversations/events/<conversationId>.json
components/conversations/interactions/<conversationId>.json  # 仅存在安全草稿时出现
```

- 索引文档 `schemaVersion` 为 2，包含每个会话的 `path`、可选 `interactionPath`、`eventCount` 和 `lastSeq`。
- Event 文档包含 `schemaVersion: 2`、`conversationId` 和按 `seq` 严格连续的 `events`。同一会话内 `eventId` 不得重复，Workspace 引用必须存在于 Manifest。
- Event Envelope 与 Conversation/Run/Turn/Item 的持久化 ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`，Payload 实体身份必须与 Envelope 坐标一致。Runtime 内部含冒号或超长坐标必须在 V2 边界确定性映射，不能把目标设备路径或随机临时值用作持久化 ID。
- Manifest 的 `conversationData.eventSegments` 必须与索引中的分段数、实际 Event 总数一致；格式固定为 `per-conversation-json`。
- `conversationData.projections` 固定为 `{ included: false, rebuildRequired: true }`。Catalog、Search、Snapshot 和其他 Projection 不进入资料包，导入端必须从 Event 重建。
- `conversationData.migrationSources` 只允许 `legacy-v1`、`profile-archive-v2` 和 `recovery`，用于审计来源，不改变导入安全策略。

Interaction 文档只允许 `schemaVersion`、`conversationId` 和 `draft`。`draft` 只允许文本、待粘贴文本与能力选择；附件路径、文件列表、排队输入、Steering、审批、Workflow、活动 Run 和其他运行态不得出现。所有文本仍执行秘密脱敏与绝对路径虚拟化。导入端始终创建空输入队列、空 Steering 和空审批集合。

当功能配置要求 Conversation V2 但事件目录不存在时，导出必须失败；不得静默回退为组件 v1。

## 资源预算

v1 默认限制由 `DEFAULT_PROFILE_ARCHIVE_LIMITS` 定义并由扫描器统一执行，包括资料包物理大小、展开大小、条目数、单条目大小、路径长度、JSON 大小/深度和压缩比。实现不得在 UI、Importer 或插件中绕过这些限制。

## 导入安全状态

- 始终创建随机 ID 的新资料，不覆盖当前资料。
- 工作区绝对路径不进入资料包；导入后全部为 `unbound`。
- Conversation V2 Projection 在目标资料内由 Event 重建，导入收据记录分段元数据、迁移来源与是否执行重建。
- Automation、Plugin 与 MCP 导入后保持禁用，活动 Run、租约、审批和设备授权不恢复。
- 用户 Skills 导入到资料内的 `extensions/skills-review` 隔离区，而不是运行时加载的 Skills 目录；导入收据记录隔离文件数。
- Remote Identity、Grant、Installation ID、缓存、临时目录和系统密文永不导出。
- 事务先写 staging，验证完成后原子提交目录，最后注册资料；中断恢复只能得到完整提交或完整回滚。

## 版本策略

兼容实现必须 fail closed。更高 Container Version、未知必需组件、缺失迁移链或任何摘要不一致都不能降级成空资料。协议升级通过新的 Container/Component Version 和显式迁移器完成，不修改 v1 既有含义。
