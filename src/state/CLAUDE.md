# State Types

[根目录](../CLAUDE.md) > **state/**

## 模块职责

TurboFlux CLI 应用的状态类型定义层。为 Ink React 组件提供状态结构定义。

## 入口与导出

| 文件 | 职责 |
|------|------|
| `src/state/types.ts` | CLI 应用状态类型定义 |

## 对外接口

导出 CLI 应用的状态类型，被 `src/cli/` 下的 hooks 和 components 引用。

## 关键依赖与配置

- 引用 `src/shared/` 中的类型
- 被 `src/cli/` UI 层消费

## 变更记录

| 日期 | 变更 | 类型 |
|------|------|------|
| — | 首次架构扫描与文档生成 | 基建 |
