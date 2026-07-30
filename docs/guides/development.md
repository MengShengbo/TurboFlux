# 本地开发

## 前置条件

- Node.js 20 或更高版本。
- npm（以 `package-lock.json` 为依赖真相）。
- Git。
- 支持 ANSI/Unicode 的终端；TUI smoke 会使用 headless terminal，不要求人工交互。

## 初始化

```bash
git clone <repository-url>
cd TurboFlux
npm ci
npm run type-check
npm test
npm run build
```

源码运行：

```bash
npm run dev:once -- .
```

持续监听 CLI：

```bash
npm run dev:cli -- .
```

运行单次任务：

```bash
npm run dev:once -- . --command "检查当前项目并给出摘要"
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run type-check` | TypeScript 无产物检查 |
| `npm test` | 完整 Vitest 测试 |
| `npm run test:flow` | Flow、TUI、会话恢复、审批和能力专项测试 |
| `npm run perf:flow` | Flow reducer/调度/窗口化性能检查 |
| `npm run smoke:tui` | headless TUI 流程 smoke |
| `npm run baseline:terminal` | 生成/评估终端矩阵基线 |
| `npm run ci:flow` | 本地复现 CI 主门禁 |
| `npm run build` | 编译 `src/` 到 `dist/` |
| `npm run runtime:info` | 输出 Node runtime 信息 |
| `npm run runtime:smoke` | Node runtime smoke |
| `npm run runtime:smoke:bun` | Bun runtime smoke（安装 Bun 时） |

## 开发循环

1. 从[模块地图](../reference/module-map.md)确认状态所有者和相邻测试。
2. 用最小测试复现问题或固定新行为。
3. 修改最窄模块，避免在 `App.tsx` 或 `agentEngine.ts` 继续堆叠可独立的生命周期。
4. 运行相关测试和类型检查。
5. 运行 `npm run ci:flow` 验证跨层影响。
6. 根据[文档覆盖矩阵](../engineering/documentation-plan.md)更新文档。

## 新增 CLI 命令

1. 在 `src/cli/commands/index.ts` 注册 name、aliases、描述 key 和 execute。
2. 在 `src/cli/i18n/messages.ts` 增加所有支持语言的可见字符串。
3. 通过 `CommandContext` 调用 Runtime 或 UI action，不直接复制领域逻辑。
4. 在 `src/cli/commands/index.test.ts` 覆盖解析、别名、成功和错误路径。
5. 用户可见命令同步更新根 README 或相应参考文档。

## 新增内置工具

1. 在 `src/core/toolRegistry.ts` 定义名称、描述、category、参数 schema 和风险元数据。
2. 在 `NodeToolExecutor` 或专用服务实现执行逻辑。
3. 文件路径通过 `CapabilityBoundary.resolvePath()`；命令通过能力与权限链路。
4. 支持取消的执行必须接收 signal 或拥有明确 kill/control 接口。
5. 结果设置合理字符预算，避免单次工具输出占满上下文。
6. 测试参数校验、能力越界、审批、并发修改、取消和错误分类。

## 新增 Flow 状态

1. 在 `src/shared/flowEvents.ts` 增加事件 payload；兼容性变化时提升 schema 版本。
2. 在 `flowReducer.ts` 维护纯归约逻辑。
3. 在 `flowSelectors.ts` 提供组件需要的派生状态。
4. 在事件桥接层发布领域事实，组件不直接推断隐式终态。
5. 添加 reducer、golden trace、ownership 和必要的 App 集成测试。
6. 如果状态需要恢复，同时扩展 Conversation Journal schema 和重放测试。

## 修改会话持久化

会话日志是兼容面。新增事件时：

- 使用新 version 或保持现有 version 的向后兼容联合类型。
- 更新 `isJournalEntry()` 运行时校验。
- 更新 replay、compact 和 recovery export。
- 覆盖损坏尾部、未知事件、重复终态和中断流。
- 验证旧 `.json` 快照与新 JSONL 能一起读取。

## 修改模型或协议

模型元数据进入 `modelRegistry.ts`，发现逻辑进入 `modelDiscovery.ts`，协议候选和兼容进入 `modelProtocol.ts`/`requestCompatibility.ts`。协议重试只能发生在未观察到语义进度前，避免重复工具调用或重复外部动作。

## 独立代理服务

开发运行：

```bash
npx tsx src/server/index.ts
```

默认管理页为 `http://127.0.0.1:8787/admin`，健康检查为 `/health`。服务配置和凭据写入当前工作区 `.turboflux/`，调试后不要提交这些运行文件。

## 调试隔离

不要使用真实用户配置跑测试。手工隔离示例：

```powershell
$env:TURBOFLUX_CONFIG_DIR = Join-Path $PWD '.tmp/turboflux-config'
$env:TURBOFLUX_CONVERSATIONS_DIR = Join-Path $PWD '.tmp/turboflux-conversations'
npm run dev:once -- .
```

结束后先确认目录仅包含本次夹具，再清理。自动测试应使用临时目录并在用例结束时释放进程、PTY、监听器和文件句柄。

## 代码风格

- 保持现有 TypeScript/ESM 风格和相邻文件格式。
- 公共边界使用明确类型；避免扩大 `any`。
- 纯状态转换与 I/O 分离，先测试纯逻辑。
- 错误携带稳定 code/kind，UI 负责本地化展示。
- 注释解释约束和原因，不复述语句。
