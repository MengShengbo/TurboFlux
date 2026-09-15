# 本地用户资料恢复与回滚 Runbook

本 Runbook 面向发布维护者和高级用户。所有恢复操作先停止 TurboFlux，保留原目录副本，并以 fail closed 为原则；禁止同时写旧目录和新资料目录。

## 发布 Flag

Stable 默认全部开启：

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `TURBOFLUX_CONVERSATION_DATA_V2` | `true` | Conversation V2 迁移、读取与唯一写入路径 |
| `TURBOFLUX_PROFILE_CENTER_V2` | `true` | Desktop 本地用户资料管理入口 |
| `TURBOFLUX_PROFILE_ARCHIVE_V2` | `true` | Desktop 资料包导入、导出与 Workspace 重绑定 |

接受 `1/0`、`true/false`、`yes/no`、`on/off`。无效值会拒绝启动相关能力。关闭 `CONVERSATION_DATA_V2` 不会回退到旧 Journal 写入；Desktop 的正常运行入口会 fail closed，只保留不会启动 Agent 的恢复路径。

旧版 `TURBOFLUX_PROFILE_STORAGE_V1`、`TURBOFLUX_LOCAL_PROFILES_UI_V1`、`TURBOFLUX_PROFILE_ARCHIVE_EXPORT_V1`、`TURBOFLUX_PROFILE_ARCHIVE_IMPORT_V1` 只作为一个稳定版本周期内的兼容输入：新 V2 变量优先；任一旧 Archive 开关为 `false` 时，统一的 `PROFILE_ARCHIVE_V2` 按 fail closed 关闭。不得在新旧变量之间实现双写。

## 默认资料迁移失败

1. 退出 TurboFlux，不删除 `~/.turboflux`。
2. 检查 `~/.turboflux/migration/profile-layout-v1-<profile-id>.json` 的失败步骤。
3. 原始 `config.json`、`conversations/`、`skills/` 和 Desktop Platform Store 会保留；迁移器不会删除来源。
4. 修复空间、权限或损坏来源后重启同版本。Journal 会从可恢复步骤继续；Conversation Catalog 和 append-only Journal 支持安全合并，分叉内容仍 fail closed。
5. 只有 Journal 为 `completed`、注册表状态为 `ready` 且数量/Digest 对账通过后，才允许清理遗留备份。

## 注册表损坏

`profiles.json` 解析失败时会保留为 `.corrupt-<timestamp>`，并从磁盘资料目录进行受限恢复。不要把未知 Storage Version 当作空资料。若恢复摘要不完整，先复制整个 `~/.turboflux/profiles`，再使用兼容版本检查。

## 导入中断

启动时 Importer 会扫描事务 Journal：

- 尚未目录提交：删除或继续安全 staging；
- 目录已提交但未注册：校验资料元数据后补注册；
- 已注册：写入收据并清理 staging；
- 无法证明一致：完整回滚并保留错误诊断。

当前资料不应因导入失败发生任何变化。不要手工把 `.staging-*` 重命名为正式资料目录。

导入的用户 Skills 位于对应资料的 `extensions/skills-review` 隔离区。该目录不会被 Agent Runtime 扫描。不要为了“恢复”而手工移动其中内容到活动 Skills 目录；先检查 `SKILL.md`、脚本和引用文件，再通过受支持的安装流程重新安装或启用。

## 回收与恢复中断

资料回收区位于注册表根下的受控目录。生命周期 Journal 会在启动时恢复“目录移动”和“注册表状态更新”之间的中断。当前资料不能回收；回收会永久撤销该资料的设备绑定 Remote Grant，恢复后必须重新配对。

## Workspace 迁移与重绑定

在 Desktop 的资料中心选择目标资料，查看工作区状态。需要重新定位时，使用“定位”或“现在定位”选择这台设备上的项目文件夹，并检查验证结果后确认绑定。

状态为 `WORKSPACE_PATH_MISSING` 时修复目录或权限；状态为 `WORKSPACE_MISMATCH_CONFIRMATION_REQUIRED` 时，先人工确认仓库、分支和来源提示，再决定是否接受指纹差异。

重绑定使用共享 Rebind Service：Conversation V2 只追加 Binding Event，不改写旧 Journal；项目和产物更新为本机路径；Automation 保持暂停，待人工确认后再恢复。

资料的创建、切换、导出、导入、回收和恢复也从 Desktop 资料中心操作。导入先创建独立资料，不自动替换当前资料。检查导入收据、资料数量和工作区绑定后，再切换到导入的资料。

## 版本降级

旧版本遇到更高资料或容器版本必须停止写入。安全路径是：

1. 使用支持当前格式的版本导出一份不含秘密的 Recovery Archive；
2. 安装目标兼容版本；
3. 将 Recovery Archive 导入为新资料并重新绑定工作区；
4. 完成对账前保留原资料根，只读保存至少一个版本周期。

禁止用旧版本覆盖新资料目录，也禁止把新资料目录直接复制回遗留单用户布局。

## 发布回滚

1. 优先关闭 `PROFILE_ARCHIVE_V2` 或 `PROFILE_CENTER_V2`，保留 `CONVERSATION_DATA_V2` 继续读取唯一事实源。
2. 若存储层存在高严重度问题，关闭 `CONVERSATION_DATA_V2` 进入 fail-closed 停机，复制资料根并使用修复版本。
3. 不恢复双写，不自动删除迁移来源，不静默降低 Storage Version。
4. 回滚完成后运行类型检查、相关测试、恶意 Fixture、真实导入导出和资料数量/Digest 对账。
