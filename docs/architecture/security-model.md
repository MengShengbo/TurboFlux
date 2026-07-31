# 安全模型

## 范围

TurboFlux 处理本地源码、命令、Git、外部模型 API、MCP 和可选代理服务。安全模型由能力边界、审批策略、工具元数据、路径规范化、凭据分离和服务绑定规则共同组成。

## 能力 Profile

| Profile | 文件读取 | 工作区写入 | 工作区外路径 | 命令能力 |
| --- | --- | --- | --- | --- |
| `read-only` | 工作区内 | 否 | 否 | 由执行器能力检查限制 |
| `workspace-write` | 工作区内 | 工作区内 | 否 | 由执行器能力检查限制 |
| `danger-full-access` | 允许 | 允许 | 允许 | 允许进入命令审批链 |

`CapabilityBoundary` 解析相对/绝对路径、拒绝空字节和 Windows drive-relative 路径，并通过真实存在的最近祖先解析符号链接。非 full profile 要求目标与工作区位于同一文件系统根且规范化后仍被工作区包含。

## 审批策略

| 策略 | 默认行为 |
| --- | --- |
| `ask` | 文件变更、命令和外部动作通常请求确认 |
| `agent` | 普通动作按规则自动推进，高风险或外部动作请求确认 |
| `full` | 完全访问：跳过一般 ask 规则并强制启用 `danger-full-access`；固定拒绝规则仍参与判断 |

`full` 是最高权限预设，不是单独的“跳过审批”开关。配置加载、setup、CLI 覆盖和会话内 `/approval full` 都会同步为 `danger-full-access`；主动切换到较低 capability 时会退出 `full`。`PermissionPipeline` 记录 decision ID，支持 run grant 和 session grant。文件写入工具可按组授权；MCP 工具、Git push、非隔离 commit、恢复操作和匹配到的危险命令拥有专门规则。

## 工具元数据

每个内置工具在 `src/core/toolRegistry.ts` 声明 category、只读性、破坏性、并发安全性、模式和参数 schema。新增工具时同时完成：

1. 定义最小参数 schema 和结果预算。
2. 标明 `isReadOnly`、`isDestructive`、`isConcurrencySafe`。
3. 在执行器中通过能力边界解析路径和命令。
4. 在权限管线中增加专用规则或确认现有默认行为。
5. 为越界、并发修改、取消和错误分类增加测试。

## 凭据与本地数据

API Key 不写入普通配置文档：

- `~/.turboflux/config.json` 保存去凭据后的模型和行为配置。
- `~/.turboflux/credentials.json` 保存 API 凭据。
- `TURBOFLUX_API_KEY` 只在当前进程覆盖活动 API Key，不会因保存其他配置而写回凭据文件。
- 代理服务把普通设置和 `server-credentials.json` 分离，并以可恢复的同目录事务更新；启动时会迁移旧 `server-config.json` 中的凭据字段。
- 配置文件解析失败时会先改名为带时间戳的 `.corrupt-*.bak` 备份，再生成可用默认文件。

日志、遥测、错误和测试夹具不得记录完整 API Key、Authorization header、用户提示词或文件内容。配置展示必须通过 `redactConfig()` 或服务端 `publicConfig()`。

## MCP 与 Skills

MCP 服务只在启动参数显式选择时连接。非 full 审批策略下，MCP 工具在共享数据或执行动作前进入确认。Skills 和自定义 Agent 属于本地代码/提示扩展面，加载目录应纳入代码评审，不把未知来源内容当作配置数据直接信任。

## Git 边界

结构化 Git 工具优先于原始 shell：

- commit 可通过显式 paths 隔离 Agent 触及文件，避免混入用户 staged 内容。
- push 在非 full 策略下请求确认。
- restore/revert 请求确认并保留可审计语义。
- 固定规则覆盖 force push、hard reset、clean 和其他高风险原始命令。

## 代理服务边界

代理服务默认绑定 `127.0.0.1:8787`。绑定到非本地地址时必须配置 `TURBOFLUX_PROXY_AUTH_TOKEN`；管理 API、健康检查、模型列表和 `/v1/*` 都经过统一 token 检查。CORS 默认只允许 `http://127.0.0.1`。

服务端普通配置位于工作区 `.turboflux/server-config.json`，密钥位于同目录 `server-credentials.json`。旧版普通配置中的密钥会在服务启动时迁移。生产化部署还应在外层提供 TLS、进程隔离、日志轮转和密钥管理，这些不属于当前内置服务职责。

## 变更检查

触及文件、命令、网络、MCP、Git、凭据或服务路由时，评审至少检查：

- 最窄 capability 是否可表达需求。
- 审批是在动作前发生，并绑定到稳定请求 ID。
- 取消、超时和进程退出是否产生终态。
- 路径是否在规范化和符号链接解析后再校验。
- 错误与日志是否已去除凭据和内容。
- 新 schema 是否带版本并兼容旧数据。
