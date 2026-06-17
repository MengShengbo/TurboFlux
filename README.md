<p align="center">
  <img src="docs/assets/turboflux-mark.svg" width="112" alt="TurboFlux logo" />
</p>

<h1 align="center">TurboFlux CLI</h1>

<p align="center">
  本地优先的 AI 工作台，用于在真实项目中规划、阅读、修改、执行命令和恢复上下文。<br />
  A local-first AI workbench for planning, editing, command execution, checkpoints, and durable workspace context.
</p>

<p align="center">
  <a href="#中文文档">中文</a> ·
  <a href="#english">English</a>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-0f172a?logo=typescript" />
  <img alt="React" src="https://img.shields.io/badge/React-19-20242a?logo=react" />
  <img alt="Ink" src="https://img.shields.io/badge/CLI-Ink-111827" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-ready-0e211c" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-0f172a" />
</p>

---

## 中文文档

### 项目定位

TurboFlux CLI 是一个本地优先的 AI 工作台。它提供终端交互界面、Agent Runtime、工具执行层、会话记忆、检查点历史、MCP 扩展和模型供应商配置能力。

TurboFlux 不绑定默认模型，也不要求先启动本地后端。首次使用时运行 `turboflux setup`，可以用交互菜单完成 API、模型、输出语言、人设风格和自定义全局指令配置。

### 架构

```mermaid
flowchart LR
  CLI["Ink 终端 CLI\nsrc/cli"] --> Runtime["Agent Runtime\nsrc/core"]
  Runtime --> Tools["工具执行层\nsrc/tools"]
  Runtime --> Memory["记忆与上下文\nsrc/tools/memory"]
  Runtime --> MCP["MCP 客户端\nsrc/core/mcp"]
  Runtime --> Profile["用户配置\n~/.turboflux/profile.json"]
  Runtime --> Provider["模型供应商\nOpenAI / Anthropic / OpenRouter / DeepSeek / Custom"]
  Runtime --> Proxy["可选本地代理\nsrc/server"]
  Tools --> Workspace["用户工作区"]
```

### 安装

macOS / Linux / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.sh | bash
```

Windows PowerShell:

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

### 初始化配置

交互式配置：

```bash
turboflux setup
```

常用子命令：

```bash
turboflux setup init       # 完整初始化：语言 + API + 人设 + 自定义配置
turboflux setup api        # 配置 API / 模型供应商
turboflux setup language   # 配置界面语言和 AI 输出语言
turboflux setup persona    # 配置人设 / 输出风格
turboflux setup custom     # 编辑全局自定义指令
turboflux setup show       # 查看当前配置
turboflux setup reset      # 重置本机配置
```

非交互示例：

```bash
turboflux setup init --provider openai --api-key <your-api-key> --model gpt-5.5 --all-lang zh-CN --yes
turboflux setup api --provider custom --api-key <your-api-key> --base-url https://api.example.com/v1 --model custom-model
turboflux setup api --provider openrouter --api-key <your-api-key>
turboflux setup language --all-lang zh-CN --yes
turboflux setup persona --output-style all --default-output-style engineer-professional --yes
```

兼容旧用法：

```bash
turboflux setup --provider openai --api-key <your-api-key> --model gpt-5.5
```

配置文件位置：

```text
~/.turboflux/config.json    # API、模型、上下文窗口等模型配置
~/.turboflux/profile.json   # 界面语言、AI 输出语言、人设和自定义指令
```

### 使用

在指定项目中启动：

```bash
turboflux /path/to/project
```

在当前目录启动：

```bash
cd /path/to/project
turboflux
```

单次任务模式：

```bash
turboflux /path/to/project --command "summarize this repository"
```

### 交互命令

```text
/help                 查看命令
/setup                查看 setup 命令
/config               查看当前模型配置
/config apiKey VALUE  手动设置 API Key
/model                选择模型
/plan                 切换到计划模式
/vibe                 切换到自主执行模式
/init                 创建 TURBOFLUX.md 项目指令
/resume               打开历史会话
/fastcontext          启动快速代码上下文扫描
/thinking             设置思考模式
```

### 可选本地代理

本地代理用于自建 OpenAI-compatible 转发和管理，不是必需组件。

```bash
npm run server
turboflux setup api --provider local-proxy --yes
```

管理页面：

```text
http://127.0.0.1:8787/admin
```

### 目录结构

```text
bin/           CLI 启动入口
src/cli/       Ink 终端 UI、斜杠命令、会话存储
src/core/      Agent Runtime、模型配置、权限、MCP、Skills、Profile
src/server/    可选本地 OpenAI-compatible 代理和管理页
src/state/     模型与共享状态契约
src/tools/     工具执行、本地历史、记忆工具
src/shared/    跨层共享类型
docs/assets/   README 与文档资源
```

### 开发

```bash
npm run dev:cli
npm run dev:server
npm run dev
npm run type-check
npm test
npm run build
```

### 安全

- API Key 仅存储在本机 `~/.turboflux/config.json`。
- 人设、语言和自定义指令存储在 `~/.turboflux/profile.json`。
- 工作区工具执行默认使用 workspace sandbox。
- 高风险命令会根据权限策略请求确认。
- Secrets、本地状态、构建输出、日志、临时文件和依赖目录不应提交到仓库。

---

## English

### What It Is

TurboFlux CLI is a local-first AI workbench for real projects. It includes a terminal UI, Agent Runtime, tool execution, conversation memory, checkpoint history, MCP extensions, and provider configuration.

TurboFlux does not bind to a default model provider. Run `turboflux setup` before the first model call to configure API access, output language, persona style, and custom instructions.

### Architecture

```mermaid
flowchart LR
  CLI["Ink Terminal CLI\nsrc/cli"] --> Runtime["Agent Runtime\nsrc/core"]
  Runtime --> Tools["Tool Execution\nsrc/tools"]
  Runtime --> Memory["Memory + Context\nsrc/tools/memory"]
  Runtime --> MCP["MCP Client\nsrc/core/mcp"]
  Runtime --> Profile["User Profile\n~/.turboflux/profile.json"]
  Runtime --> Provider["Model Provider\nOpenAI / Anthropic / OpenRouter / DeepSeek / Custom"]
  Runtime --> Proxy["Optional Local Proxy\nsrc/server"]
  Tools --> Workspace["User Workspace"]
```

### Install

macOS / Linux / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.ps1 | iex
```

Manual source install:

```bash
git clone https://github.com/MengShengbo/TurboFluxCli.git
cd TurboFluxCli
npm install
npm install -g .
```

### Configure

Interactive setup:

```bash
turboflux setup
```

Useful setup commands:

```bash
turboflux setup init
turboflux setup api
turboflux setup language
turboflux setup persona
turboflux setup custom
turboflux setup show
turboflux setup reset
```

Non-interactive examples:

```bash
turboflux setup init --provider openai --api-key <your-api-key> --model gpt-5.5 --all-lang en --yes
turboflux setup api --provider custom --api-key <your-api-key> --base-url https://api.example.com/v1 --model custom-model
turboflux setup language --all-lang en --yes
turboflux setup persona --output-style all --default-output-style engineer-professional --yes
```

### Use

```bash
turboflux /path/to/project
turboflux /path/to/project --command "summarize this repository"
```

### Optional Local Proxy

```bash
npm run server
turboflux setup api --provider local-proxy --yes
```

Admin console:

```text
http://127.0.0.1:8787/admin
```

### Development

```bash
npm run dev:cli
npm run dev:server
npm run dev
npm run type-check
npm test
npm run build
```

### Safety

- API keys are stored locally in `~/.turboflux/config.json`.
- Language, persona, and custom instructions are stored in `~/.turboflux/profile.json`.
- Workspace tool execution defaults to a workspace sandbox.
- High-risk commands require approval depending on the active permission policy.
- Secrets, local state, build output, logs, temporary files, and dependencies should not be committed.

## License

MIT
