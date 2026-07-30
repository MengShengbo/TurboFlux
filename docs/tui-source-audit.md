# TurboFlux TUI 源码深读审计

> 本文是基于当前仓库源码与测试的事实审计，不是未来架构愿景。文中“现状”由代码直接证明；“工程化建议”是后续工作，不代表已经完成。

## 审计范围与规模

本次逐层阅读范围：

- TUI 入口：`src/cli/index.ts`、`repl.ts`、`singleShot.ts`、`components/App.tsx`。
- TUI 状态：`src/cli/state/`、Flow Event、selectors、feature flags、telemetry。
- 输入与终端：`PromptInput`、输入状态机、viewport、windowing、terminal attention/size/mouse。
- 会话：`ConversationManager`、`ConversationJournalWriter`、store/replay/recovery export。
- 核心执行：`AgentEngine`、`createAgentRuntime`、permissions、capability boundary、RuntimeTaskManager、SubAgentTaskManager、NodeToolExecutor。
- 扩展与辅助：命令注册、工具注册、MCP、Skills、记忆、Git、模型协议、可选 server。
- 测试与门禁：102 个测试文件、804 个通过测试、3 个跳过；`ci:flow` 和三平台 GitHub Actions。

当前生产 TypeScript/TSX 约 42,000 行，其中 `src/cli` 约 21,000 行；`App.tsx` 约 2,300 行，是最大 TUI 集成文件。

## 产品身份

TurboFlux 的产品主体是本地终端 TUI，而不是通用 Agent SDK 或桌面端。默认交互路径是：

```text
turboflux [workspace]
  -> Commander 解析参数
  -> startRepl()
  -> startInkApp()
  -> Ink render()
  -> App
  -> createAgentRuntime() + ConversationManager + AgentFlowController
```

`--command` 进入 `runSingleShot()`，仍复用 `createAgentRuntime()` 和会话记录，但不进入完整交互式 TUI。

## TUI 渲染模式

`startInkApp()` 根据交互性、single-shot 和 `noFlicker` 选择两条渲染路径：

| 模式 | Ink 选项 | 内容策略 | 用途 |
| --- | --- | --- | --- |
| 固定 cockpit | `alternateScreen: true`、`incrementalRendering: true`、`maxFps: 24` | `TranscriptViewport` + 可选 `WindowedMessageList`，原地滚动和局部刷新 | 交互式 TUI 默认 |
| scrollback | `alternateScreen: false`、`incrementalRendering: false`、`maxFps: 18` | Ink `Static` 固化历史消息，底部绘制运行区/输入/状态 | 兼容终端、single-shot 或显式关闭 no-flicker |

`App` 只在真实 TTY 且非 single-shot 时启用固定 cockpit；非交互输出不会启用鼠标跟踪、通知标题或启动动画。

## App 的真实职责

`App.tsx` 目前同时承担：

1. 创建 Runtime、ConversationManager、FlowController、遥测和终端 attention。
2. 订阅 `AgentEngine` 全部事件并把事件分发到 React 展示状态、Flow Store 和会话持久化。
3. 管理输入草稿、图片附件、历史、steering、queued prompts、Ctrl-C、双 Esc rewind 和 slash command。
4. 管理 streaming/thinking 缓冲、工具状态、FastContext、子代理、PTY、Git、通知和审批 modal。
5. 计算 cockpit/sidebar/landing 布局并在两套渲染模式中输出 Ink 树。

这不是“理想边界”，而是当前代码事实。它也是首要工程热点：新增交互若直接继续写入 App，会增加闭包、ref、effect 和清理顺序的耦合。

## 三类状态

### 领域事实

由 `AgentEngine`、`RuntimeTaskManager`、`ConversationManager` 等服务拥有：模型回合、工具结果、审批请求、任务状态、会话 turns、上下文、Git、PTY 和持久化健康。

### Flow UI 事实

`AgentFlowController` 把 `AgentEventType` 转成 schema v2 `FlowEventEnvelope`；`FlowStore` 按 thread 保存 `ThreadFlowState`；`flowReducer` 处理 run、input、approval、tool、stream、runtime、notification、persistence 和 invariant violations；selectors 为 UI 输出派生状态。

Flow reducer 会记录 `sequence_gap`、`missing_item_id`、`unknown_item`、`terminal_reversal`、`identity_mismatch`。这使它成为 UI 状态的一致性检测器，而不是简单 Redux 替代物。

### React 展示缓存

App 仍直接持有 stream buffer、thinking buffer、current tools、change summaries、FastContext UI event buffer、subagent activity、terminal sessions、pending ask、overlay、cursor、scroll rows、startup elapsed 和 notification snapshot。这些值用于及时绘制或兼容旧路径，不是 durable truth。

## Flow 不等于持久化日志

当前代码没有把 `AnyFlowEvent` 直接写入 Conversation Journal。持久化路径是：

```text
AgentEngine event
  -> ConversationManager.recordEvent()
  -> v1/v2 ConversationJournalEntry
  -> ConversationJournalWriter
  -> <conversation-id>.jsonl
```

FlowController 只在进程内 dispatch 到 FlowStore。恢复时由 Conversation Store 重放会话事件、snapshot、queue/draft/input/approval 状态，再由 App 恢复 Engine、消息和交互提示；不会重建完整 Flow Event 序列。

## 输入与终端交互

`PromptInput` 是受控 React 输入框，但光标、history index、draft、双 Esc、completion selection 和 `TerminalInputStateMachine` 保存在组件/ref 中。输入状态机根据字符间隔、批量字符和显式 paste 判断是否把 Enter 转为换行，从而避免终端粘贴多行文本时误提交。

已覆盖的 TUI 输入事实包括：Unicode/CJK/emoji 光标边界、图片 placeholder 原子导航和删除、命令补全、history draft 恢复、透明背景下 prompt 全单元绘制、Ctrl/Meta alternate submit。

`App` 顶层还负责 Ctrl-C：运行中第一次中断 Engine；若响应尚未开始则恢复 prompt 和 prior turns；空闲时需要在 1.8 秒内再次 Ctrl-C 才退出。

## Transcript 与性能

- `TranscriptViewport` 以行数而非消息数维护滚动，支持锚点保持、page step、mouse wheel 和选中消息 reveal。
- `transcriptWindowing` 估算每条消息高度，按 prefix rows 计算窗口，并保留 12 行 overscan；已测量消息高度会覆盖估算。
- `AdaptiveStreamScheduler` 在 smooth/catch-up 两种模式间切换，用 depth、oldest age 和输入优先窗口调节 flush。
- Markdown、Flow event、journal batching、terminal latency 和 mounted/total transcript cells 都有本地指标。

这些优化只在对应 feature flag 开启时生效；关闭 windowing/scheduler 后仍有旧路径。

## 会话与 Runtime Journal

会话 JSONL 记录 turn、stream、tool、context state，以及 v2 的 queue、draft、steer、approval；stream 和 draft 可以批量合并。写入失败后 ConversationManager 进入 degraded，普通提交/新会话/切换会被阻断，可用 `/flow retry` 或 `/flow export`。

Runtime Journal 位于工作区 `.turboflux/runtime/journal.jsonl`，记录 RuntimeTaskManager 事件。启动恢复时会重放合法行；未结束任务若进程仍存活标记 running，否则标记 orphaned，并将 recovered/controlAvailable 写入 metadata。

两种 journal 有不同 schema、所有者和恢复语义，不能合并称为“Flow 日志”。

## 核心后端在 TUI 中的角色

- `createAgentRuntime()` 是对象图组合根，但不是产品入口；TUI App 和 single-shot 都调用它。
- `AgentEngine` 管理模型协议候选（Anthropic Messages、OpenAI Responses、OpenAI-compatible）、stream 解析、工具循环、上下文压缩、steering、FastContext、Git、权限和事件。
- `NodeToolExecutor` 集中实现文件、搜索、代码地图、记忆、命令、PTY、网络请求和工具结果分页，是第二个大热点。
- `RuntimeTaskManager` 统一 shell/terminal/agent/fast_context/mcp/workflow/remote 任务，并负责输出日志、控制和恢复。
- `SubAgentTaskManager` 在 Runtime Task 上增加 transcript、owner session 和结果。

这些服务被 TUI 消费，但 TUI 不应把它们误写成独立 daemon 或桌面 IPC 层；当前代码是单进程组合。

## 工程债务（源码证据）

| 优先级 | 事实 | 影响 |
| --- | --- | --- |
| P0 | `App.tsx` 创建服务、桥接所有事件并渲染两套树 | 变更影响面大，清理顺序依赖 effect |
| P0 | `AgentEngine` 同时拥有协议、上下文、Git、权限、工具调度、FastContext 和事件 | 单测和协议变更需要跨大文件定位 |
| P0 | `NodeToolExecutor` 同时拥有文件、搜索、PTY、命令、网络和记忆 | 本地能力边界与工具分派难以独立演进 |
| P1 | Flow Store 是内存投影，Conversation Journal 是另一套事件映射 | 恢复后 Flow seq/violations 不可直接追溯 |
| P1 | 固定 cockpit 与 scrollback 两套渲染逻辑并存 | 新 UI 需要验证两条路径 |
| P1 | 版本号仍在 `package.json`、CLI、brand、setup、MCP 等多处出现 | 发布存在漂移风险 |
| P2 | `src/server` 与 TUI 共仓但不是默认入口 | 文档和测试必须明确它是辅助服务 |

## 后续工程化顺序

1. 从 App 提取 `TuiRuntimeBridge`：只负责 EngineEvent → UI/Flow/Conversation 分发，不改变 UI 行为。
2. 将 React 展示缓存分成 `foregroundRunModel`、`backgroundInboxModel`、`terminalModel` 三个可测试 adapter。
3. 为 Flow 与 Conversation 建立明确的 projection/recovery contract，而不是让两者看起来像同一事件源。
4. 从 NodeToolExecutor 抽出 `WorkspaceFileService`、`ProcessService`、`TerminalService`、`WebSearchService`、`MemoryService` facade。
5. 将版本改为 `package.json` 单一来源，补包内容和文档链接门禁。

## 结论

TurboFlux 当前已经有相当完整的 TUI 运行基础：固定 cockpit、scrollback fallback、可恢复输入、Flow invariant 检测、窗口化 transcript、自适应 stream flush、会话 degraded/retry/export 和 Runtime orphan recovery。下一阶段不是重新设计一个抽象 Agent 平台，而是围绕 TUI 主链路拆分集成热点、统一事实来源并保持两种渲染模式行为一致。
