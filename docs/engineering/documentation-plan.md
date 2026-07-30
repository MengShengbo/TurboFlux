# TUI 工程化文档方案

## 定位

TurboFlux 文档以 TUI 真实行为为中心，先记录“按键/事件/状态/渲染/持久化”事实，再记录拆分和自动化建议。不会把通用 Agent、桌面端或独立服务架构套到当前代码上。

## 文档分层

```text
README.md                       用户入口
CONTRIBUTING.md                 贡献与门禁
docs/README.md                  文档入口
docs/tui-source-audit.md        本次逐模块源码事实审计
docs/architecture/              TUI 启动、渲染、事件、恢复和边界
docs/guides/                    开发/测试操作
docs/reference/                 TUI 模块、命令、配置、数据路径
docs/operations/                发布/排障
docs/adr/                       跨模块决策
docs/*.md                       历史路线/专项材料
```

## 源码—文档矩阵

| 源码 | 当前事实文档 | 触发更新 |
| --- | --- | --- |
| `src/cli/index.ts`、`repl.ts`、`singleShot.ts` | TUI 系统总览、配置参考 | CLI 参数、模式分流、输出变化 |
| `src/cli/components/App.tsx` | TUI 审计、运行生命周期、模块地图 | 状态桥接、渲染树、清理链变化 |
| `src/cli/components/input/` | 运行生命周期、开发指南 | 输入快捷键、粘贴、Unicode、图片变化 |
| `src/cli/components/messages/`、`TranscriptViewport.tsx` | TUI 审计、测试策略 | transcript、窗口化、滚动策略变化 |
| `src/cli/state/`、`src/shared/flowEvents.ts` | TUI 审计、运行生命周期 | Flow schema、reducer invariant、selector 变化 |
| `src/cli/conversations/` | 运行生命周期、配置参考、排障 | Journal schema、degraded、replay、export 变化 |
| `src/core/agentEngine.ts` | 系统总览、运行生命周期、模块地图 | 协议、工具 loop、事件、context、abort 变化 |
| `src/core/runtime/`、`nodeToolExecutor.ts` | 系统总览、安全模型、审计 | 任务、PTY、能力、恢复和执行面变化 |
| `src/cli/commands/`、`toolRegistry.ts` | 模块地图、配置参考 | 命令/工具注册、参数和风险变化 |
| `src/server/` | 系统总览、安全模型、配置参考 | 可选代理路由/绑定/鉴权变化 |
| `scripts/`、`.github/workflows/` | 测试策略、发布手册 | 门禁、性能、终端矩阵变化 |

## 每次 TUI 变更的检查

1. 输入是否改变？补 Prompt/快捷键测试。
2. Flow 事件是否改变？补 schema/reducer/golden trace 测试。
3. 是否改变固定 cockpit 和 scrollback 两条渲染路径？两条都验证。
4. 是否改变会话恢复？更新 Journal 类型、replay 和损坏尾部测试。
5. 是否改变通知/审批/后台任务终态？验证 App 展示与 Runtime 资源清理。
6. 是否改变终端尺寸、ANSI、TTY 或性能？运行 smoke/baseline/perf。

## 明确的当前债务

- App 仍是最大 TUI 集成热点。
- Flow Store 与 Conversation Journal 不是同一事件源。
- Engine/NodeToolExecutor 多职责仍在现状中。
- 两套渲染路径需要双重验证。
- 版本号多处硬编码。

这些是工程化工作的输入，不应在文档中写成已完成重构。

## 实施顺序

1. 已完成：TUI 源码事实审计与导航入口。
2. 下一步：提取 App 的 EngineEvent/Flow/Conversation bridge，保持行为不变。
3. 下一步：为固定 cockpit 与 scrollback 建立相同场景的行为矩阵。
4. 下一步：拆分 NodeToolExecutor 的 facade，并保持 ToolExecutor 兼容接口。
5. 下一步：明确 Flow projection 的恢复策略，必要时新增 ADR。
6. 最后：加入 Markdown 链接、命令存在性、版本一致性和包内容 CI 检查。

## 完成标准

- 每个用户可见 TUI 行为都能定位到实现和测试。
- 文档区分领域事实、Flow 事实、React 展示缓存和 durable journal。
- 固定 cockpit、scrollback、single-shot、非 TTY 的差异有明确说明。
- 任何架构建议都标注为后续工作，不冒充当前能力。
- 代码、测试、脚本和文档引用同一命令与路径事实。
