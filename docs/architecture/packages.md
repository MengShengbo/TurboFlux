# TurboFlux 包架构

Desktop 与 Orbit 使用同一组领域包名称，并在各自 worktree 内安装、构建。顶层 `TurboFlux/` 是工作区容器。业务实现不再归属 `agent-core`。

## 职责与数据所有权

| 包 | 负责 | 公共数据与入口 |
| --- | --- | --- |
| `contracts` | 浏览器与宿主共享的协议、类型及纯规则 | AgentTurn、ToolCall、ToolResult、ConversationEvent、模型配置、状态、Git 与工具执行接口 |
| `platform` | Node 文件、进程、网络和用户目录适配 | 原子文件操作、锁、ActiveProfilePaths、运行环境 |
| `models` | 模型发现、配置、凭据及协议转换 | ModelPreset、配置存取、流解析、请求兼容处理 |
| `tools` | 实际工具执行、权限、搜索、记忆和后台进程 | NodeToolExecutor、RuntimeTaskManager、PermissionPipeline |
| `extensions` | MCP、Skills、本地插件与 Work Pack | McpClient、SkillRuntime、PluginService；Skills 通过 SkillPromptTarget 注入指令 |
| `agent-runtime` | Agent 执行与生命周期、上下文、子任务协调 | AgentEngine、createAgentRuntime、运行控制与事件 |
| `conversations` | 会话事件、存储、恢复、迁移与隐私处理 | ConversationRepositoryV2、事件日志、会话管理 |
| `profiles` | 用户资料隔离、工作区绑定、归档与导入导出 | ProfileStorageLayout、迁移与 Archive 服务 |
| `automations` | 自动化定义、调度、路由、恢复与投递事实 | AutomationDefinition、AutomationRun、Repository 与 Coordinator |
| `presentation` | 无 DOM 的确定性界面投影 | ConversationViewState、TaskFlowProjectionState、TranscriptIndex |
| `renderer` | 浏览器渲染引擎 | RenderScheduler、KeyedList、RenderLifetime；时间线、Markdown、工具结果、源码、差异与工作计划 |
| `workbench` | 应用层装配和服务 | WorkbenchRuntime、设置、项目、产物、命令及任务会话 |
| `remote-protocol` | 远控配对、授权、加密与同步 | 保留独立的宿主和浏览器入口 |
| `agent-core` | 旧客户端的兼容导出 | 原有六个入口；无业务实现，新代码禁止依赖它 |

`apps/desktop` 拥有 Electron、IPC、原生浏览器/电脑/终端驱动、界面装配与产品样式。`apps/remote-mobile` 消费远控协议。原有模型代理移入 `apps/model-proxy`，作为叶子应用维护，运行时不依赖它。

## 依赖规则

基础层是 `contracts` 和 `platform`。模型、工具、扩展与自动化依赖基础层。Agent 运行时组合这些能力，会话与 Profile 服务在其上提供持久化，`workbench` 负责最后装配。界面投影只依赖契约；浏览器渲染引擎依赖界面投影。所有跨包引用必须使用声明过的包入口，禁止 `../另一个包/src`、`dist` 深导入和循环依赖，包括类型依赖。

`scripts/verify-architecture.mjs` 明确列出允许依赖并解析 TypeScript import/export/dynamic import。它检查跨目录访问、未声明依赖、未公开入口、循环依赖和浏览器代码引入 Node/Electron。修改依赖图必须同时更新架构决策与检查。

`contracts` 不从实现层获取类型：模型配置、Git 快照和 ToolExecutor 接口已下沉。Skills 接收最小的 `SkillPromptTarget`，不依赖 AgentEngine。`presentation` 使用事件和快照类型，不导入会话存储或运行时。

## 桌面渲染流程

1. IPC 事件同步经过 `applyConversationViewEvent`，按 conversation、generation 和 sequence 接受，避免旧快照覆盖新事件。
2. `TranscriptIndex` 在接收数据时维护消息、调用、结果和内容版本；绘制时按 ID 获取，避免每个工具节点扫描整个历史。
3. `RenderScheduler` 按 surface 合并同一帧内的任务。快照状态同步落地，DOM 绘制延后；同帧只采用最新状态。重入任务进入下一帧，单个 surface 失败不会阻断其他 surface。
4. `KeyedList` 保留节点，增删与重排按稳定 key 处理。消息与工具以实际内容版本失效，同长度修改也刷新，展开状态和焦点尽量保留。
5. `RenderLifetime` 拥有全局监听器、帧任务、定时器、IPC 订阅和观察器。`mountWorkbench` 返回释放函数；页面离开或热更新会执行清理，拒绝晚到结果。

页面骨架与图标在 `workbenchShell.ts`、`workbenchIcons.ts`；宿主动作和页面状态在 `workbench.ts`。样式保持在应用端，运行状态的事实来源仍是运行时及持久化事件。

本轮没有实现历史列表虚拟化。极长会话仍保留 DOM 节点，性能结论限于合并刷新、索引查找和节点复用，不能视作任意规模会话的性能保证。

## 构建与验证

从 worktree 根目录运行 `npm install`。根目录只声明开发工具，各包声明自己的运行依赖，整个 worktree 只有一个锁文件。

- `npm run build:packages`：解析 manifest 的依赖图，按拓扑顺序构建全部包，生成 JS、声明和插件子进程资源。`build:core` 是此命令的兼容别名。
- `npm run type-check:all`：检查包和应用。各包也可独立检查；上游声明需要先构建。
- `npm test`：先构建包，再运行当前源码测试；多进程测试使用本次构建产物。
- `npm run test:desktop`、`npm run test:remote`：桌面与远控回归。
- `npm run verify:architecture`、`verify:boundary`、`verify:workspace`：持续执行结构约束。
- `npm run qa:desktop:renderer`：在独立临时 Profile 中运行真实 Electron 和本地测试模型，检查流式消息节点、完成、新建/切换会话、历史回放和订阅释放。

开发启动监听所有包的源目录。Electron 打包通过应用 manifest 收集传递依赖；打包检查要求新包存在，不依赖开发机器上旧 `agent-core/dist`。

## Orbit 集成

Orbit worktree 同样按上述领域职责迁移。其 `KernelRuntime` 与版本化事件接口属于 `@turboflux/workbench`，通用 Agent 实现属于 `agent-runtime`，原有 `kernel-protocol`、`kernel-policy`、`kernel-state`、`kernel-execution` 四包保留。小球及 Orbit 分支的桌面入口消费 workbench，终端原型保持现有入口。

两个 worktree 仍然是独立分支，包名相同不代表实现自动同步。不要通过跨 worktree 的 source alias 或拷贝 dist 来共享事实。后续集成应通过 Git 合并、明确解决分支差异，再独立验证各入口。桌面主线的新 renderer 包尚未替换 Orbit 分支旧桌面 UI，Orbit 本身的小球渲染不属于任务时间线引擎。
