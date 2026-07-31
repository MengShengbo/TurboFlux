<h1 align="center">TurboFlux</h1>

<p align="center"><strong>全新的开源终端 AI Agent，为真实的软件工程工作流而生。</strong></p>

<p align="center">
  在一个完整的 TUI 中理解代码、推进任务、执行工具、审阅 diff，并把关键执行过程清楚地交给开发者。
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-20242a?logo=node.js" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-20242a?logo=typescript" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-20242a" />
</p>

TurboFlux 不是把聊天窗口简单搬进终端。它把 Agent 的推理状态、检索、文件修改、命令执行、Git 变更和验证过程组织成一个持续可见的工程工作台：你负责目标和判断，TurboFlux 负责在真实项目里推进实现。

> [!IMPORTANT]
> TurboFlux 正在快速演进中。当前版本以完整的终端用户界面（TUI）作为核心产品形态，交互设计、运行时与 Agent 能力仍会持续打磨。

## 为什么是 TurboFlux

- **TUI 原生，而非聊天框套壳**：会话、任务、工具活动、终端进程、上下文与 diff 在同一界面中协同呈现。
- **让执行过程可观察**：文件读取、代码编辑和命令调用从开始到结束都有明确状态，长任务也能持续追踪。
- **为代码审阅而设计**：展示真实 unified diff，以文件、hunk 和变更类型组织修改；快照超限或无法读取时会明确说明原因。
- **结构化 Git 联动**：围绕 status、diff、commit、restore、revert、branch、stash 和 push 构建可审计的工程流程。
- **面向长时间工作**：支持后台终端任务、会话恢复、上下文压缩和项目记忆，让 Agent 可以持续推进复杂任务。
- **开放的模型与工具生态**：支持多种 API Provider、OpenAI-compatible 接口、Skills、MCP 与自定义子代理。

## 一分钟开始

```bash
npm install -g github:MengShengbo/TurboFluxCli
turboflux setup
cd your-project
turboflux
```

进入界面后，直接描述一个完整目标：

```text
检查用户登录流程，修复会话过期后无法重新认证的问题，并运行相关测试。
```

TurboFlux 会探索项目、制定执行路径、修改代码、运行验证，并把工具活动和最终变更呈现在 TUI 中。

## 安装

需要 Node.js 20 或更高版本。

```bash
# npm
npm install -g github:MengShengbo/TurboFluxCli

# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.ps1 | iex
```

从源码安装：

```bash
git clone https://github.com/MengShengbo/TurboFluxCli.git
cd TurboFluxCli
npm install
npm install -g .
```

## 配置

首次使用先运行：

```bash
turboflux setup
```

TurboFlux 支持 OpenAI、Anthropic、DeepSeek、Kimi、GLM、OpenRouter 和自定义 OpenAI-compatible API。配置保存在 `~/.turboflux/config.json`，API Key 单独保存在 `~/.turboflux/credentials.json`。

```bash
turboflux setup api          # API 连接
turboflux setup language     # 界面与输出语言
turboflux setup persona      # 输出风格
turboflux setup approval     # 工具审批策略
turboflux setup show         # 查看当前配置
```

## 使用方式

```bash
# 在当前目录启动
turboflux

# 打开指定项目
turboflux /path/to/project

# 执行一次任务后退出
turboflux /path/to/project --command "检查登录流程并修复问题"

# 临时调整本次会话的审批策略
turboflux /path/to/project --approval-policy agent
```

TurboFlux 可以搜索和阅读代码、编辑文件、运行命令、启动后台终端、查看真实 diff、管理任务，并在完成后继续验证结果。工具一经调用就会出现在工作区中，并在执行完成前保持动态状态；你不需要通过静止的聊天记录猜测 Agent 是否仍在工作。

文件修改会按文件和 hunk 展示 unified diff。常规快照默认完整展开；超过当前快照计算上限或修改后文件无法重新读取时，界面会保留变更统计并明确显示无法生成 diff 的原因，不会静默隐藏。

会话会自动保存。使用 `/resume` 恢复历史会话，或在输入框中连续按两次 `Esc` 回到之前的某条消息。

启动时会读取当前 API 可用的模型；尚未指定模型时自动使用发现结果中的第一个。模型发现不可用时可执行 `/model add <模型ID>`，无法取得上下文上限时使用 200K 默认值。

## Agent 工作流

TurboFlux 有两种工作模式：

- **vibe**：默认模式，自主完成检索、修改和验证。
- **plan**：只读分析并制定计划；切换到 `/vibe` 后执行修改。

在会话中使用 `/vibe` 和 `/plan` 切换。输入 `/effort` 可直接选择当前模型原生支持的推理档位；当 Provider 返回 reasoning 内容时，`Ctrl+O` 用于展开或折叠这些内容。

审批策略分为 `ask`（写文件和执行命令前询问）、`agent`（低风险操作自动继续，检测到风险时询问）和 `full`（跳过审批提示；通用危险命令规则仍然生效）。

项目可以从 `.turboflux/agents/*.md` 加载自定义子代理；主 Agent 也可以直接使用代码搜索、符号索引和代码地图工具定位实现。

## 图片输入

Windows 终端支持直接粘贴剪贴板图片：

1. 复制截图或图片。
2. 在 TurboFlux 输入框按 `Ctrl+V`。
3. 输入框出现 `[Image #1]` 后正常发送。

也可以粘贴本地图片路径：

```text
帮我看看 C:\Users\me\Desktop\error.png
对比 ./before.png 和 ./after.png
```

支持 PNG、JPEG、WebP、GIF 和 BMP，单张图片最大 5 MB。所选模型需要支持视觉输入。

## 上下文与记忆

TurboFlux 会根据模型返回的 token 用量管理长会话：

- 自动生成阶段性 recap。
- 接近上下文上限时压缩较早的对话。
- 保留最近消息、工具结果、任务和文件信息。
- 使用 `/context` 查看用量，使用 `/compact` 手动压缩。

项目规则支持 `TURBOFLUX.md`，也会读取 `CLAUDE.md`、`AGENTS.md`、`.cursorrules` 和 `.cursor/rules/` 等常见格式。

长期记忆保存在项目的 `.turboflux/memory/` 中，可以由 Agent 使用 `remember`、`list_memories` 和 `forget` 管理。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看全部命令 |
| `/model` | 选择或切换模型 |
| `/plan` | 切换到计划模式 |
| `/vibe` | 切换到自主执行模式 |
| `/effort` | 调整当前模型的原生推理强度 |
| `/approval` | 设置工具审批策略 |
| `/context` | 查看上下文用量 |
| `/compact` | 压缩当前会话 |
| `/resume` | 恢复历史会话 |
| `/new` | 开始新会话 |
| `/mcp` | 查看 MCP 服务与工具 |
| `/skills` | 查看已加载的 Skills |
| `/git [on\|off\|refresh]` | 查看、开关或刷新结构化 Git 集成 |

> [!NOTE]
> Git 仓库默认启用结构化联动。TurboFlux 会显示检测、就绪、同步、错误等明确状态，并使用隔离 index 自动提交 Agent 触碰的文件；用户已有的 staged 内容不会混入提交，也不会自动 push。Git 是文件变更追踪与恢复的唯一基础设施。

Agent 可直接使用结构化的 status、diff、log、show、stage、commit、restore、revert、branch、stash 和 push 工具。`git_restore` 拒绝覆盖已有 staged 变更，`git_revert` 通过新提交保留审计历史；push 在 `ask` 和 `agent` 策略下必须经过审批，`full` 策略会跳过该提示。强制推送、硬重置和清理工作树不属于结构化工具能力。

## Skills 与 MCP

Skill 放在以下目录：

```text
<workspace>/.turboflux/skills/<name>/SKILL.md
~/.turboflux/skills/<name>/SKILL.md
```

MCP 配置支持项目级和全局级文件：

```text
<workspace>/.turboflux/settings.json
~/.turboflux/settings.json
```

当前支持 stdio MCP：

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["path/to/server.js"],
      "enabled": true
    }
  }
}
```

MCP 默认不启动，需要在启动 TurboFlux 时显式指定：

```bash
turboflux . --mcp all
turboflux . --mcp server-name
```

## 终端透明背景

终端模拟器负责真正的透明效果。TurboFlux 的 `--transparent` 只停止绘制大面积背景色，让 iTerm2、Windows Terminal、WezTerm、GNOME Terminal 等模拟器的背景透出：

```bash
turboflux . --transparent
# 或
TURBOFLUX_TRANSPARENT=1 turboflux .
```

Windows PowerShell：

```powershell
$env:TURBOFLUX_TRANSPARENT = '1'
turboflux .
```

该模式保留文字、边框、diff 和状态颜色；`--transparent` 不会改变终端模拟器自身的透明度设置。若环境变量曾被持久化设置，可用 `turboflux . --opaque` 强制恢复完整深色背景。

## 开发

```bash
npm install
npm run dev:once -- .
npm test
npm run type-check
npm run build
```

主要目录：

```text
src/cli/          Ink TUI 与交互状态
src/core/         Agent 循环、上下文、模型与子代理
src/tools/        工具执行与记忆
src/shared/       共享类型
```

完整的架构、开发、测试、配置、发布与排障文档见 [`docs/README.md`](docs/README.md)。参与贡献前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## License

MIT
