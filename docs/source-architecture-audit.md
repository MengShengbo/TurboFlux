# TurboFlux 源码结构审计

更新时间：2026-07-21

这份文档用于减少后续维护时重复阅读巨型文件的成本。原则是先抽纯函数和稳定边界，不重写运行核心。

## 当前热点

| 文件 | 规模 | 主要职责 | 风险 |
| --- | ---: | --- | --- |
| `src/core/agentEngine.ts` | 约 6000 行 | 会话循环、协议请求、工具调度、权限、上下文、子代理 | 任何改动都可能跨越多个生命周期 |
| `src/core/runtime/nodeToolExecutor.ts` | 约 2000 行 | 文件、搜索、命令、终端、HTTP、检查点、记忆 | 安全边界与基础设施逻辑混合 |
| `src/cli/components/App.tsx` | 约 1580 行 | TUI 状态、事件桥接、输入、历史、滚动、覆盖层 | React 状态与 Agent 事件高度耦合 |
| `src/core/subAgent.ts` | 约 1150 行 | 子代理协议、重试、工具循环、结果压缩 | 与主 Agent 存在协议兼容重复逻辑 |
| `src/cli/setup.ts` | 约 1060 行 | 配置迁移、交互步骤、供应商和人设设置 | 配置规则与交互流程混合 |

## 本轮已完成

- `src/cli/components/appHelpers.ts`：承接消息转换、回滚定位、环境开关和 UI 纯函数。
- `src/core/requestCompatibility.ts`：统一主 Agent 与子代理的可选参数移除、原生推理档位降级和错误识别。
- 修复 `runProcess()` 在 `readonly` sandbox 中仍可启动进程的问题。
- 子代理不再因为一个 reasoning 字段不兼容而删除整组原生推理参数。

## 仍需处理的问题

### P1：AgentEngine 仍承担三种协议传输

Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 的请求构造、SSE 解析与结果归一化仍在 `agentEngine.ts`。下一步应先定义统一的协议结果类型，再逐个迁移，不要一次性重写三条链路。

### P1：NodeToolExecutor 职责过多

建议按以下顺序拆分：

1. Web Search 客户端与 HTML 解析。
2. Code Search / CodeMap 本地索引适配。
3. 前台进程与后台终端管理。
4. 文件系统与 workspace sandbox 保留为执行器核心。

### P1：App 事件桥接过大

`engine.subscribe()` 中的事件归并、stream buffer、thinking buffer 和持久化触发可以迁移到单独 hook。先保持现有 state 形状，禁止同时改 UI 布局。

### P2：ToolExecutor 类型边界宽松

`Result<any>`、`Record<string, any>` 和可选方法较多。应从高频工具开始增加命名返回类型，不要一次性开启 `noImplicitAny` 或全量改签名。

### P2：Setup 流程难以局部维护

供应商选择、模型发现、推理设置、人设和权限策略可以拆成独立 step；配置读写与交互提示应保持分离。

## 改动约束

- 每次只迁移一个职责边界。
- 迁移前补纯函数或协议 contract 测试。
- 不改变工具名、事件名、持久化结构和公开命令。
- 每轮必须通过 `npm run type-check`、`npm test` 和 `npm run build`。
- 禁止借模块化同时重写 UI、上下文策略或 Agent 主循环。
