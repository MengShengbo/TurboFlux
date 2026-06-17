# Shared Types

[根目录](../CLAUDE.md) > **shared/**

## 模块职责

TurboFlux 的共享类型定义层 — 所有模块之间的数据契约在此定义。包括智能体类型、工具类型、记忆系统类型、子智能体类型、代码索引类型和通用类型。

## 入口与导出

| 文件 | 职责 |
|------|------|
| `src/shared/types.ts` | 通用类型：`AiModel`, `SystemConfig`, `ProviderConfig`, `ModelConfig` 等 |
| `src/shared/agentTypes.ts` | 智能体类型：`TurnStrategy`, `AgentContext`, `Turn`, `EditResult`, `AgentConfig` |
| `src/shared/toolTypes.ts` | 工具类型：`ToolDefinition`, `ToolCall`, `ToolResult`, `ToolConfig` |
| `src/shared/memoryTypes.ts` | 记忆类型：`EpisodicMemory`, `MemoryEntry`, `MemoryQuery`, `MemoryConfig` |
| `src/shared/subAgentTypes.ts` | 子智能体类型：`SubAgentConfig`, `SubAgentResult`, `SubAgentContext` |
| `src/shared/codeIndexTypes.ts` | 代码索引类型：`IndexEntry`, `SymbolEntry`, `CodeIndex`, `IndexConfig` |

## 对外接口

所有文件导出纯类型定义（`interface` / `type`），无运行时逻辑。

### 关键类型概览

| 类型 | 文件 | 用途 |
|------|------|------|
| `TurnStrategy` | `agentTypes.ts` | 对话轮次策略（单轮/多轮/流式） |
| `AgentContext` | `agentTypes.ts` | 智能体运行上下文 |
| `ToolDefinition` | `toolTypes.ts` | 工具注册定义 |
| `MemoryEntry` | `memoryTypes.ts` | 单条记忆条目 |
| `SubAgentConfig` | `subAgentTypes.ts` | 子智能体配置 |
| `IndexEntry` | `codeIndexTypes.ts` | 代码索引条目 |
| `SystemConfig` | `types.ts` | 系统级配置 |

## 关键依赖与配置

- **无运行时依赖** — 纯类型定义
- 被 `src/core/`, `src/cli/`, `src/tools/`, `src/state/` 所有模块引用

## 数据模型

见上表。所有类型为纯 TypeScript `interface` / `type` 定义，部分包含 JSDoc 注释。

## 变更记录

| 日期 | 变更 | 类型 |
|------|------|------|
| — | 首次架构扫描与文档生成 | 基建 |
