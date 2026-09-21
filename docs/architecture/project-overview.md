# TurboFlux 架构总览

TurboFlux 按领域包组织，详细职责、依赖和验收命令见 [包架构](packages.md)。当前 worktree 是独立 npm workspace；顶层工作区容器不是安装根目录。

Desktop Renderer 使用 `@turboflux/renderer`，通过 preload / IPC 连接 DesktopRuntimeHost。宿主以 `@turboflux/workbench` 的 WorkbenchRuntime 组织应用服务，再由 `@turboflux/agent-runtime` 执行 Agent。浏览器、电脑与终端驱动由 Electron 宿主注入，运行时包不依赖 Electron。

数据协议位于 `contracts`，平台适配位于 `platform`，模型、工具、扩展、会话、资料、自动化各自归属独立包。`presentation` 维护纯界面投影，`renderer` 负责节点渲染与资源生命周期。`agent-core` 仅保留旧入口兼容导出。

| 阅读目标 | 源码入口 |
| --- | --- |
| 桌面装配、状态和 IPC | `apps/desktop/renderer/workbench.ts`、`apps/desktop/preload.cjs` |
| 帧调度、节点复用与资源清理 | `packages/renderer/src/scheduler.ts`、`keyedList.ts`、`lifetime.ts` |
| 会话与任务视图 | `packages/presentation/src/conversationViewProjection.ts`、`transcriptIndex.ts` |
| Electron 与运行时宿主 | `apps/desktop/main.mjs`、`runtimeHost.ts` |
| 应用编排 | `packages/workbench/src/workbench/workbenchRuntime.ts` |
| Agent 装配与执行 | `packages/agent-runtime/src/runtime/agentRuntime.ts`、`agentEngine.ts` |
| 会话持久化 | `packages/conversations/src/conversations/conversationRepositoryV2.ts` |
| 远控 | `packages/remote-protocol`、`apps/remote-mobile` |

`apps/model-proxy` 是原有模型代理的独立叶子应用，不属于内核。安装与运行见项目 README；包边界由 `verify:architecture` 持续检查。
