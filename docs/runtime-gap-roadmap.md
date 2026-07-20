# TurboFlux Runtime 差距与改进路线

本文记录 TurboFlux 与根目录 `claude-code-reference` 的源码级对比结果，作为后续 Runtime 改造的工作底稿。

## 结论

TurboFlux 当前的主要差距不是工具数量，而是缺少统一、可持久化的任务运行时。现有 `TaskManager` 负责计划树、进度和 UI 状态，但不拥有命令进程、输出日志、子代理或会话恢复生命周期。

## 后台持久化的三个层级

### 1. 当前 CLI 进程内后台运行

TurboFlux 已支持 `run_command(run_in_background=true)`、`list_terminals`、`read_terminal` 和 `kill_terminal`，但目前只属于进程内后台任务：

- 后台终端保存在 `NodeToolExecutor.backgroundTerminals` 内存 Map 中。
- 输出最多保留 500 个 chunk、100 万字符，旧输出淘汰后不会报告日志缺口。
- 输出没有落盘，CLI 崩溃后无法继续读取。
- `ptyCreate` 实际使用标准子进程管道，不是真正的 PTY/ConPTY。
- 后台命令被写入一个长期存活的 Shell。有限命令结束后 Shell 通常不会退出，因此无法可靠判断命令完成和退出码。
- 没有暴露给 Agent 的 stdin 写入工具，也没有 resize、attach 和交互提示处理。
- Runtime 销毁时会调用 `ptyKillAll()`。

Claude Code 的普通后台 Bash 任务仍依赖当前 CLI 进程，但具备独立 Task 状态、磁盘输出、增量 byte offset、输出上限、完成通知、阻塞提示检测和前台转后台能力。

### 2. 关闭终端后继续运行

要让任务在关闭 TUI 后继续，需要由独立进程持有子进程和日志流。仅保存 PID 无法在 CLI 重启后重新连接 stdout、stderr 和 stdin。

`claude-code-reference` 中存在 feature-gated 的 `--bg`、`ps`、`logs`、`attach`、`kill` 入口，但重建源码缺少对应 `src/cli/bg.js`，因此只能确认接口存在，不能把具体实现作为已完整验证的基线。

### 3. 机器重启后恢复

运行中的进程不能跨机器重启继续。合理语义应是：

- 启动时将原任务标记为 `interrupted` 或 `orphaned`。
- 对开发服务器、监控任务等允许配置 `restartPolicy`。
- 一次性构建、测试、迁移任务默认不自动重跑，避免重复副作用。

## 已确认的 P0 问题

### 命令超时可能永久等待

前台命令超时后只调用进程树终止逻辑，Promise 仍等待 `close` 或 `error`。Windows 下 `taskkill.exe` 被异步启动并 `unref()`，如果终止失败或子进程不触发关闭事件，Agent 可能一直卡住。

状态：已于 2026-07-17 修复。超时后会进入固定终止宽限期；即使子进程不触发 `close`，工具调用也会强制结算并保留终止失败信息。

验收标准：

- 超时后进入固定长度的终止宽限期。
- 宽限期结束后无条件结算工具调用并返回 `timedOut=true`。
- 记录终止失败信息，但不能让主 Agent 永久等待。

### stdout 与 stderr 会被丢弃一半

当前成功命令只返回 stdout，失败命令只返回 stderr。编译器、测试框架和包管理器经常混合使用两个通道，导致模型看不到完整诊断。

状态：已于 2026-07-18 完成。Agent 会同时收到带通道标签的 stdout、stderr、exitCode、timedOut 和 truncated；完整输出按通道追加写入 `.turboflux/runtime-logs/*.jsonl`，工具结果同时返回日志路径。

验收标准：

- 工具结果同时保留 stdout、stderr、exitCode、timedOut 和 truncated。
- 面向模型的文本按时间顺序或明确通道标签组合。
- 大输出写入文件，只向上下文注入尾部摘要和日志路径。

### 后台命令没有真实完成状态

当前实现启动长期 Shell，再通过 stdin 写入命令。Shell 的生命周期不等于命令的生命周期，因此 `npm test`、`npm run build` 等有限任务可能一直显示 `running`。

验收标准：

- 一条命令对应一个 Runtime Task 和一个可观测子进程。
- 子进程退出即更新 `completed` 或 `failed`，保存退出码并发送完成事件。
- 交互终端与一次性命令使用不同执行模式。

### 会话无法可靠崩溃恢复

当前会话以完整 JSON 原子重写，并使用 500ms debounce。用户消息刚提交、模型正在流式输出或工具正在执行时发生硬崩溃，当前 turn 可能丢失。

状态：已于 2026-07-18 完成。会话改为版本化 JSONL journal，立即追加用户 turn、assistant delta、tool call/result、interrupt 和 compact state；旧 `.json` 会话继续可读。回放会跳过损坏尾行、补记中断 assistant，并为缺失工具结果生成 `abort` 结果以恢复合法工具链。journal 压缩与归档仍属于后续维护项。

验收标准：

- 用户提交、assistant delta、tool call、tool result、interrupt 和 compact boundary 使用 append-only journal。
- 启动时识别未完成模型输出、未解决 tool use 和未回答用户消息。
- 恢复时清理无效工具链，并明确标记 interrupted turn。

## 建议的 RuntimeTaskManager

状态：已于 2026-07-18 建立进程内 `RuntimeTaskManager`，前台 Shell、后台 Terminal、FastContext 和普通子代理已接入统一的创建、运行、停止与终态管理；命令日志和子代理 transcript 已落盘，重启时会恢复历史任务并将未完成任务标记为 `interrupted`，真实跨进程续跑仍需 Runtime Daemon。

统一任务模型至少包含：

```text
id, kind, ownerSessionId, parentTaskId
status, command, cwd, pid
startedAt, updatedAt, endedAt, exitCode
logPath, outputOffset, outputBytes
interactive, restartPolicy, metadata
```

任务类型建议统一为：

- `shell`
- `terminal`
- `agent`
- `fast_context`
- `mcp`
- `workflow`
- `remote`

Runtime 需要提供：

- `task_start`
- `task_list`
- `task_output`
- `task_write`
- `task_stop`
- `task_attach`

## 推荐架构

### 第一阶段：进程内统一 Runtime

进展：前台 Shell、后台 Terminal、FastContext 与普通子代理已接入统一任务状态和追加式日志，终态会发布 `runtime-task:finished`，Agent 可通过 `write_terminal` 写入 stdin，并通过 `list_agents`、`read_agent`、`cancel_agent` 管理后台子代理。日志轮转和日志缺口提示仍未完成。

1. 将 Shell、Terminal、FastContext 和普通子代理接入统一任务状态。
2. 输出采用 append-only 文件，读取使用 byte offset。
3. 修复命令超时、退出码、stdout/stderr 和完成通知。
4. 增加日志上限、轮转和缺口提示。

### 第二阶段：会话与子代理恢复

进展：append-only 会话 journal、普通子代理独立 transcript、后台运行、取消和崩溃后 `interrupted` 回放已完成；向运行中 Agent 追加消息、重新启动 Agent 和可选 Git worktree 尚未完成。

1. 将会话存储改为 append-only journal。
2. 为普通子代理保存独立 transcript。
3. 支持后台运行、取消、追加消息和恢复 Agent。
4. 增加可选 Git worktree 隔离。

### 第三阶段：独立 Runtime Daemon

1. Daemon 持有子进程、PTY 和任务注册表。
2. CLI 通过 Windows Named Pipe 或 Unix Domain Socket 连接。
3. 支持 detach、attach、logs、stop 和多客户端订阅。
4. CLI 退出时不再默认终止允许后台保留的任务。

### 第四阶段：扩展与企业能力

1. Hook Runtime：工具、权限、用户提交、压缩、会话和子代理生命周期。
2. MCP：SSE、Streamable HTTP、WebSocket、OAuth、resources、prompts、elicitation 和重连。
3. 权限规则真实加载，并接入项目、用户和企业策略来源。
4. 使用 OS 级 sandbox，替换命令字符串路径扫描。
5. API Key 接入系统安全存储。

## 上下文管理改进

TurboFlux 已具备 context segments、reservoir、文件恢复、手动 compact 和自动 compact。后续重点不是重写，而是减少有损摘要：

- 不再将 assistant turn 固定截断为 300 字、其他 turn 截断为 200 字。
- 摘要器直接读取结构化工具调用、工具结果、任务状态和文件变更。
- 压缩后恢复计划、已调用 Skills、后台 Agent 和 Runtime Task 状态。
- 增加 micro-compaction，优先清理重复读取和陈旧工具输出。
- 增加 PreCompact/PostCompact Hook 和压缩失败熔断。

## 当前优势

以下能力应保留并继续强化，不需要照搬 Claude Code：

- FastContext 可以与主 Agent 并行工作，并只向主上下文注入紧凑证据。
- context segments 与 reservoir 已形成自己的上下文恢复方式。
- checkpoint 和本地历史适合高风险编辑恢复。
- 图片粘贴、多模型供应商和 FastContext 分档检索具备产品辨识度。
- 自定义 TUI 已能承载 Work、Task、终端和 Agent 活动信息。

## 实施顺序

1. [x] 修复前台命令永久等待和输出丢失。
2. [x] 建立进程内 `RuntimeTaskManager`。
3. [x] 命令输出落盘、完成事件和 stdin 工具。
4. [x] append-only 会话 journal 与崩溃恢复。
5. [x] 后台及可恢复子代理。
6. [ ] Runtime Daemon 与 detach/attach。
7. [ ] Hooks、完整 MCP、sandbox、LSP 和远程调度。
