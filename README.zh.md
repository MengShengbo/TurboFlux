# TurboFlux

[English](README.md) | 中文

TurboFlux 是由执行内核和 Electron 桌面应用组成的开源本地 Agent 工作台。你可以配置自己的模型服务，在本地项目中执行任务，并通过 Desktop 查看会话、审批、进度和结果。

## 当前范围

- **Agent Core 内核**：模型接入、Agent 执行、工具、上下文管理、会话、Skills、MCP、Plugins 和本地资料服务。
- **Desktop 桌面端**：任务与会话界面、设置、本地资料、浏览器与电脑适配、终端集成及自动化。
- **桌面远控配套**：通过配对的浏览器客户端和加密协议控制已授权的 Desktop。实际执行和模型凭据保留在桌面主机。

## 快速开始

准备 **Node.js 22.12 或更新版本**、npm 和 [ripgrep](https://github.com/BurntSushi/ripgrep)。在仓库根目录安装依赖，由 npm 链接各 workspace 包。

```sh
git clone https://github.com/MengShengbo/TurboFlux.git
cd TurboFlux
npm ci
npm run dev:desktop
```

在 Desktop 设置中配置模型地址和 API Key。原生能力取决于操作系统和授权；电脑操控使用 macOS 辅助功能权限。

开发服务器默认使用 `http://127.0.0.1:15174`。需要调整端口时运行：

```sh
TURBOFLUX_DESKTOP_PORT=25174 npm run dev:desktop
```

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| [`packages/agent-core`](packages/agent-core) | 执行内核和平台无关的应用服务 |
| [`apps/desktop`](apps/desktop) | Electron 应用、Renderer 和原生宿主适配 |
| [`packages/remote-protocol`](packages/remote-protocol) | 桌面设备配对、能力授权、加密命令和事件 |
| [`apps/remote-mobile`](apps/remote-mobile) | Desktop 的远控 PWA |
| [`docs`](docs/README.md) | 架构、开发、隐私与运维文档 |
| `scripts` | 构建、边界检查、打包、基准和验收工具 |

Desktop 通过公共包导出消费内核。`DesktopRuntimeHost` 装配 `WorkbenchRuntime`，再创建 `AgentRuntime` 和 `AgentEngine`。浏览器、电脑和终端原生能力由宿主注入。详见[架构总览](docs/architecture/project-overview.md)和[仓库边界](docs/architecture/repository-boundary.md)。

## 开发与验证

```sh
npm run build                 # 构建内核和 Desktop，包含桌面远控资源
npm run type-check            # 内核类型检查
npm test                      # 内核测试
npm run type-check:desktop
npm run test:desktop
npm run test:remote
npm run verify:boundary
npm run verify:architecture
npm run verify:workspace
npm run ci                    # 完整本地检查流程
```

单独构建内核使用 `npm run build:core`。生成未封装的 Desktop 应用目录使用 `npm run package:dir --workspace @turboflux/desktop`。签名及各平台分发需要对应平台的工具链和证书。

桌面远控配置参见[运维指南](docs/architecture/remote-shell-runbook.md)。浏览器客户端需要可信 HTTPS，并与 Desktop 主机配对。

## 参与项目

通过 [Issues](https://github.com/MengShengbo/TurboFlux/issues) 提交问题和建议。目前暂不接受外部 Pull Request，详见[贡献指南](CONTRIBUTING.zh.md)。

## 许可证

[MIT](LICENSE)
