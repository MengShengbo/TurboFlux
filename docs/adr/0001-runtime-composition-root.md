# ADR-0001：以 Agent Runtime 作为核心组合根

- 状态：accepted
- 日期：2026-07-30
- 决策者：TurboFlux 维护团队
- 关联：`src/core/runtime/agentRuntime.ts`

## 上下文

AgentEngine 需要模型配置、工具执行、后台任务、子代理、Skills、MCP 和会话身份。若 CLI、single-shot、测试或未来入口分别手工装配这些依赖，所有权、销毁顺序和配置更新会逐渐分叉。

## 决策

`createAgentRuntime()` 是核心对象图的组合根。入口通过它获得 Engine、状态提供器、工具执行器、Runtime Task、SubAgent Task、Skill、MCP 和 Session Registry；配置更新走 `applyConfiguration()`，释放走 `destroy()`。

领域服务不引用 Ink 组件。会话身份变化由 `SessionRegistry` 广播到所有拥有 owner/conversation ID 的服务。后台任务完成通过 Runtime 事件回到 Engine，而不是由 UI 猜测。

## 替代方案

- 由 `App.tsx` 直接创建全部服务：使 UI 成为领域生命周期所有者，难以复用和测试。
- 由 `AgentEngine` 内部 new 全部依赖：隐藏依赖并扩大单体职责。
- 使用全局 singleton 容器：跨测试和多会话容易泄漏状态，销毁顺序不明确。

## 后果

### 正向

- CLI 与未来入口共享同一装配语义。
- 生命周期、监听解绑和资源关闭集中可测。
- Engine 可通过接口依赖更小的服务。
- 会话切换与后台任务 owner 保持一致。

### 代价

- 新核心服务需要修改 Runtime 接口和组合根。
- 组合根本身需要防止变成业务逻辑聚集点。
- 配置更新必须显式同步到受影响服务。

### 风险与缓解

- 遗漏销毁：为每个资源增加 destroy/stop 测试并在 Runtime 统一调用。
- 身份不同步：Session Registry 测试覆盖切换和运行中 guard。
- Runtime 接口膨胀：只暴露入口真正需要的服务，领域操作优先通过 Engine/专用 facade。

## 实施

当前组合根创建全部核心服务，注册 Runtime Task 完成监听和 Session 身份监听；`destroy()` 断开 MCP、停止任务、关闭 PTY、解绑订阅并销毁 Engine。

## 验证

- `src/core/runtime/agentRuntime.test.ts`
- `src/core/runtime/sessionRegistry.test.ts`
- `src/core/runtime/runtimeTaskManager.test.ts`
- `src/core/runtime/subAgentTaskManager.test.ts`

## 后续

- 进一步缩小 `AgentRuntime` 暴露面。
- 为销毁后的监听器、timer 和 PTY 增加统一泄漏断言。
- 未来独立 daemon 仍以明确的 Runtime API 作为进程边界。
