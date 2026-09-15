# TurboFlux 项目介绍

TurboFlux 是一个开源本地 Agent 工作台，当前由 Agent Core 内核和 Desktop 桌面端组成。用户配置自己的模型服务，选择本地工作区，并通过任务、会话和审批界面控制执行过程。

## Agent Core

内核位于 `packages/agent-core`，负责模型请求、Agent 循环、工具执行、上下文管理、会话持久化、任务编排以及本地资料服务。Skills、MCP、Plugins 和 Work Packs 提供本地扩展能力。公共导出将执行逻辑与 Desktop 界面和原生驱动分开。

## Desktop

桌面端位于 `apps/desktop`，使用 Electron、Vite 和 TypeScript。Renderer 展示任务、会话、检索结果、工具活动、设置和资料中心；主进程负责应用生命周期、系统权限、浏览器、电脑和终端适配，并通过运行时宿主调用内核。

Desktop 的远控功能由 `apps/remote-mobile` 和 `packages/remote-protocol` 配套实现。浏览器客户端需要与桌面主机配对，执行和模型凭据保留在主机。

## 开发

使用 Node.js 22.12+、npm 和 ripgrep，在仓库根目录运行 `npm ci`，再运行 `npm run dev:desktop`。完整检查命令为 `npm run ci`，包括静态检查、类型检查、测试、构建和仓库边界验证。

源码和问题反馈位于 [MengShengbo/TurboFlux](https://github.com/MengShengbo/TurboFlux)。更多说明见[项目 README](../README.zh.md)、[架构总览](architecture/project-overview.md)和[文档目录](README.md)。
