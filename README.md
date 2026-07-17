<h1 align="center">TurboFlux CLI</h1>

<p align="center">TurboFlux CLI 是一个开源的终端 AI Coding Agent。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-20242a?logo=node.js" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-20242a?logo=typescript" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-20242a" />
</p>

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
turboflux setup api          # API 与模型
turboflux setup fastcontext  # FastContext 单独使用的模型
turboflux setup language     # 界面与输出语言
turboflux setup persona      # 输出风格
turboflux setup approval     # 工具审批策略
turboflux setup show         # 查看当前配置
```

## 使用

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

TurboFlux 可以搜索和阅读代码、编辑文件、运行命令、启动后台终端、查看 diff、管理任务，并在完成后继续验证结果。

会话会自动保存。使用 `/resume` 恢复历史会话，或在输入框中连续按两次 `Esc` 回到之前的某条消息。

`/model` 会读取当前 API Key 可用的模型，并显示上下文、输出上限和主要能力；无法取得模型上限时使用 200K 默认上下文，仍可通过 `/config contextWindow` 自定义。

## Agents

TurboFlux 有两种工作模式：

- **vibe**：默认模式，直接完成检索、修改和验证。
- **plan**：只读分析并制定计划；切换到 `/vibe` 后执行修改。

在会话中使用 `/vibe` 和 `/plan` 切换。输入 `/effort` 可直接选择当前模型原生支持的推理档位，也可以使用 `/effort high` 等命令快速调整。

审批策略分为 `ask`（写文件和执行命令前询问）、`agent`（低风险操作自动继续，检测到风险时询问）和 `full`（完全访问；灾难性命令仍会阻止）。

内置子代理：

- **fast_context**：在独立上下文中搜索项目，返回相关文件和行号。
- **explorer**：追踪功能实现、调用链和跨文件关系。
- **reviewer**：检查代码质量、安全问题和潜在缺陷。
- **git_inspector**：分析提交记录和代码变更。

FastContext 由主 Agent 按需调用，不提供单独的 `/fastcontext` 命令。它默认跟随主模型，也可以通过 `turboflux setup fastcontext` 分配独立配置。

项目还可以从 `.turboflux/agents/*.md` 加载自定义子代理。

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

支持 PNG、JPEG、WebP 和 GIF，单张图片最大 5 MB。所选模型需要支持视觉输入。

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

> [!NOTE]
> 文件修改默认保存到本地历史，不创建 Git 提交。在 Git 仓库中使用 `/git on` 后，checkpoint 才会提交本轮 Agent 触碰的文件；不会自动 push。

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
src/cli/          Ink 终端界面
src/core/         Agent 循环、上下文、模型与子代理
src/tools/        工具、本地历史与记忆
src/shared/       共享类型
```

## License

MIT
