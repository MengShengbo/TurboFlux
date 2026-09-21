# 内核运行与关闭生命周期

## 职责

| 层 | 拥有的生命周期 |
| --- | --- |
| `AgentRunLifecycle` | 单次前台运行、引导输入、运行状态和取消控制 |
| `AgentRunControl` | 整轮停止、当前操作暂停、恢复后的操作信号 |
| `AgentEngine` | 前台运行和上下文压缩的收尾、事件及内部协调器释放 |
| `RuntimeTaskManager` | 后台进程与子任务的停止、终态日志和控制句柄 |
| `AgentRuntime` | 引擎、后台任务、终端、MCP 和会话订阅的整体关闭 |
| `WorkbenchRuntime` | 会话加载、前台任务持久化、插件与所有会话的关闭 |

拆包后的源码分别位于 `packages/agent-runtime/src/`（引擎与运行协调）、`packages/tools/src/runtimeTaskManager.ts`（后台任务）和 `packages/workbench/src/workbench/`（工作台）。

## 运行约束

- `AgentRunLifecycle.run()` 在执行回调前登记运行 Promise 和取消控制。首个事件的监听者看到的 `isRunning()` 已为真；事件回调中的重复启动被拒绝，不修改原任务。
- 返回的 Promise 在释放运行占用后才完成。成功、失败和同步启动异常均通过同一收尾路径关闭引导输入，并清理暂停状态。
- `stop` 是本轮不可逆操作；在收尾完成前，仍保留运行占用，但不能再次暂停或恢复，也不能开始新的重试操作。
- 已发布完成或失败终态的运行，在 Promise 收尾期间不会被迟到的暂停、恢复或停止操作改回活动状态。
- 停止、销毁发出取消信号；实际运行和压缩 Promise 保留到操作结束。`waitUntilIdle()` 因此仍能等待取消后的收尾。

## 关闭顺序

宿主通过 `await runtime.destroy()` 关闭完整运行时。只管理 `AgentEngine` 的调用方可以使用 `await engine.shutdown()`；同步 `engine.destroy()` 发出取消并释放内部资源，需要等待运行结束时仍应调用 `waitUntilIdle()`。

`AgentRuntime.destroy()` 首先关闭引擎的新运行入口，然后并行请求引擎收尾、后台任务停止、终端释放和 MCP 断开。一个资源失败不会跳过其他资源；所有清理结束后解除订阅，并通过 `AggregateError` 返回失败。关闭中的配置修改和会话切换被拒绝。

`RuntimeTaskManager` 对同一任务共享正在进行的停止操作，保留同步取消与日志写入时序。批量停止会向所有任务发出停止请求，不等待前一个任务退出后才取消下一个。停止尚未结束的任务不能因保留数量限制被提前删除或切换到另一会话。

`WorkbenchRuntime` 先禁止新工作，再停止已接纳的会话任务，同时等待正在加载的会话退出。会话在前台运行与历史改写收尾后解除插件连接、释放记录器和运行时，最后刷新会话目录。插件连接解除、资源关闭和会话收尾继续使用有时限的等待；达到时限仅结束宿主等待，不代表底层操作已经结束。

运行时、工作台和单个会话的重复销毁返回同一个 Promise。调用方等待的是完整清理结果，不会因另一个调用方已开始关闭而提前成功。

## 验证

相关回归覆盖启动事件重入、取消监听者异常、停止后恢复、取消后等待、并发销毁、断开失败、慢任务批量停止和子任务终态恢复。主要测试位于 `packages/agent-runtime/src/agentEngine.lifecycle.test.ts`、该包的 `runtime/` 测试、`packages/tools/src/runtimeTaskManager.test.ts` 和 `packages/workbench/src/workbench/workbenchRuntime.lifecycle.test.ts`。
