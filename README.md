<p align="center">
  <img src="docs/assets/turboflux-mark.svg" alt="TurboFlux" width="96" />
</p>

<h1 align="center">TurboFlux</h1>

<p align="center">本地运行的终端编码 Agent。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-20242a?logo=node.js" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-20242a?logo=typescript" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-20242a" />
</p>

给 TurboFlux 一个项目目录和一项任务，它会查代码、改文件、跑命令。工具调用、任务进度和代码 diff 都显示在 TUI 里。

<p align="center">
  <img src="turboflux-tui.png" alt="TurboFlux TUI" width="960" />
</p>

> [!NOTE]
> 项目还在开发中，命令、配置和界面可能继续调整。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
npm install -g github:MengShengbo/TurboFluxCli
turboflux setup
cd your-project
turboflux
```

`setup` 会引导你配置模型服务。进入界面后直接输入任务，例如：

```text
检查登录流程，修复会话过期后无法重新认证的问题，并运行相关测试。
```

其他安装方式：

```bash
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.ps1 | iex
```

<details>
<summary>从源码安装</summary>

```bash
git clone https://github.com/MengShengbo/TurboFluxCli.git
cd TurboFluxCli
npm install
npm install -g .
```

</details>

## 功能

- 搜索和读取代码，修改文件，运行前台或后台命令。
- 按文件和 hunk 展示 unified diff，并保留每次工具调用的状态。
- 自动保存会话，支持历史恢复、上下文压缩和项目记忆。
- 在 Git 仓库中查看、提交、恢复和回退 Agent 产生的修改。
- 接入 OpenAI、Anthropic、DeepSeek、Kimi、GLM、OpenRouter 和 OpenAI-compatible API。
- 通过 Skills、MCP 和自定义子代理扩展工具。

## 配置

```bash
turboflux setup api          # API 连接
turboflux setup language     # 界面和输出语言
turboflux setup persona      # 输出风格
turboflux setup approval     # 工具审批策略
turboflux setup show         # 查看当前配置
```

普通配置保存在 `~/.turboflux/config.json`，API Key 单独保存在 `~/.turboflux/credentials.json`。

启动指定项目或执行单次任务：

```bash
turboflux /path/to/project
turboflux /path/to/project --command "检查登录流程并修复问题"
```

## 模式与审批

| 模式 | 行为 |
| --- | --- |
| `vibe` | 默认模式，可以检索、修改代码并运行验证 |
| `plan` | 只读分析并整理计划，不修改项目 |

使用 `/vibe` 和 `/plan` 切换模式，使用 `/effort` 调整当前模型的推理档位。

| 审批策略 | 行为 |
| --- | --- |
| `ask` | 写文件或运行命令前询问 |
| `agent` | 低风险操作自动继续，检测到风险时询问 |
| `full` | 不显示审批提示；启用 `danger-full-access`，放开工作区外路径、命令和网络限制 |

三种策略都会保留通用危险命令规则。启动时可用 `--approval-policy <策略>` 临时覆盖配置。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看全部命令 |
| `/model` | 选择或添加模型 |
| `/plan`、`/vibe` | 切换工作模式 |
| `/effort` | 调整推理档位 |
| `/approval` | 设置审批策略 |
| `/context`、`/compact` | 查看或压缩上下文 |
| `/resume`、`/new` | 恢复会话或开始新会话 |
| `/mcp`、`/skills` | 查看已加载的扩展 |
| `/git [on\|off\|refresh]` | 查看、开关或刷新 Git 集成 |

在输入框中连续按两次 `Esc`，可以回到之前的消息继续编辑。Provider 返回 reasoning 内容时，按 `Ctrl+O` 展开或折叠。

## Git

Git 集成默认开启。自动提交使用隔离的 index，只包含 Agent 修改的文件，不会混入你已有的 staged 内容，也不会自动 push。结构化 Git 工具不提供强制推送、硬重置和工作树清理。

## 项目规则与扩展

项目规则优先写在 `TURBOFLUX.md`。TurboFlux 也会读取 `CLAUDE.md`、`AGENTS.md`、`.cursorrules` 和 `.cursor/rules/`。

```text
<workspace>/.turboflux/skills/<name>/SKILL.md
~/.turboflux/skills/<name>/SKILL.md
<workspace>/.turboflux/agents/<name>.md
<workspace>/.turboflux/settings.json
~/.turboflux/settings.json
```

MCP 默认不启动，需要在命令行指定服务名或 `all`：

```bash
turboflux . --mcp all
turboflux . --mcp server-name
```

目前支持 stdio MCP。配置格式见[配置参考](docs/reference/configuration.md)。

## 终端功能

Windows 终端支持用 `Ctrl+V` 直接粘贴剪贴板图片，也可以在消息中输入本地图片路径。支持 PNG、JPEG、WebP、GIF 和 BMP，单张图片最大 5 MB；所选模型需要支持视觉输入。

TurboFlux 默认绘制实色背景。Windows Terminal 使用透明度、Acrylic 或背景图时会自动匹配；其他终端可运行 `turboflux . --transparent`。`--opaque`、`--transparent` 和 `TURBOFLUX_TRANSPARENT` 可显式覆盖自动检测结果。

## 开发

```bash
npm install
npm run dev:once -- .
npm test
npm run type-check
npm run build
```

项目文档从 [`docs/README.md`](docs/README.md) 开始：

- [系统总览](docs/architecture/system-overview.md)
- [配置参考](docs/reference/configuration.md)
- [本地开发](docs/guides/development.md)
- [排障手册](docs/operations/troubleshooting.md)
- [贡献指南](CONTRIBUTING.md)

## License

MIT
