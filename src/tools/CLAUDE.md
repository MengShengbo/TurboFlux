# Tool Implementations

[根目录](../CLAUDE.md) > **tools/**

## 模块职责

TurboFlux 的具体工具实现层。包含工具执行器、代码索引、本地历史记录和记忆系统工具。

## 入口与导出

| 文件 | 职责 |
|------|------|
| `src/tools/executor.ts` | 工具执行器 — 工具调用的具体执行逻辑 |
| `src/tools/codeIndex.ts` | 代码索引工具 — 代码符号搜索与索引 |
| `src/tools/localHistory.ts` | 本地历史工具 — 操作历史追踪 |
| `src/tools/memory.ts` | 记忆工具 — 长期记忆的读写 |

## 对外接口

每个文件导出的函数/类被 `src/core/toolOrchestrator.ts` 和 `src/core/toolDispatcher.ts` 调用。

| 工具 | 文件 | 说明 |
|------|------|------|
| `executeTool` | `executor.ts` | 工具执行主入口 |
| `searchCode` / `indexCode` | `codeIndex.ts` | 代码搜索与索引 |
| `getHistory` / `saveHistory` | `localHistory.ts` | 本地历史管理 |
| `remember` / `recall` | `memory.ts` | 记忆系统读写 |

## 关键依赖与配置

- 依赖 `src/shared/` 中的类型定义
- 被 `src/core/` 引擎层调用
- 无外部 API 依赖（纯本地实现）

## 变更记录

| 日期 | 变更 | 类型 |
|------|------|------|
| — | 首次架构扫描与文档生成 | 基建 |
