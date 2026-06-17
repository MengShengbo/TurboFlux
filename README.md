<p align="center">
  <img src="docs/assets/turboflux-mark.svg" width="112" alt="TurboFlux logo" />
</p>

<h1 align="center">TurboFlux CLI</h1>

<p align="center">
  一个本地 AI 工作台：把工作区任务转成计划、代码修改、命令执行、检查点和可延续上下文。
  <br />
  A local AI workbench for plans, edits, command runs, checkpoints, and durable workspace context.
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

TurboFlux CLI 是一个实验性的本地 AI 工作台。它把终端 CLI、共享 Agent Runtime、工具执行层、记忆与上下文、检查点历史，以及本地 OpenAI-compatible 模型代理组合在一起。

它更像开发者本机的工作流工具，而不是托管 SaaS 后端。核心目标是让 AI 能够在真实工作区里读代码、制定计划、执行命令、修改文件、保留上下文，并在必要时通过权限和检查点降低误操作风险。

> 当前开源仓库只包含 CLI 与本地代理相关源码，不包含桌面端源码。

### 系统架构

```mermaid
flowchart LR
  CLI["Ink 终端 CLI\nsrc/cli"] --> Runtime["Agent Runtime\nsrc/core"]
  Runtime --> Tools["工具执行层\nsrc/tools"]
  Runtime --> Memory["记忆与上下文\nsrc/tools/memory"]
  Runtime --> MCP["MCP 客户端\nsrc/core/mcp"]
  Runtime --> Proxy["本地模型代理\nsrc/server"]
  Proxy --> Provider["OpenAI-compatible\n或上游模型服务"]
  Tools --> Workspace["用户工作区"]
```

### 运行要求

- Node.js 20 或更新版本
- npm
- 可选：`rg` / ripgrep，用于更快的代码搜索

### 一行公网安装

不注册 npm 也可以用 GitHub 公网脚本安装。脚本会检查 Node.js/npm，然后执行 `npm install -g github:MengShengbo/TurboFluxCli`。

macOS / Linux / Git Bash：

```bash
curl -fsSL https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/MengShengbo/TurboFluxCli/main/install.ps1 | iex
```

安装后验证：

```bash
turboflux --version
turboflux --help
```

> 安装脚本是公开文件，执行前可以先打开 `install.sh` 或 `install.ps1` 查看内容。它只会检查 Node/npm、安装 TurboFlux CLI、输出版本号。

### 从源码全局安装

普通用户下载源码后，推荐直接在项目根目录执行全局安装：

```bash
git clone https://github.com/MengShengbo/TurboFluxCli.git
cd TurboFluxCli
npm install
npm install -g .
```

验证全局命令：

```bash
turboflux --version
turboflux --help
```

启动一个工作区：

```bash
turboflux /path/to/your/project
```

在当前目录启动：

```bash
cd /path/to/your/project
turboflux
```

单次任务模式：

```bash
turboflux /path/to/your/project --command "summarize this repository"
```

卸载全局命令：

```bash
npm uninstall -g turboflux
```

### 开发者本地调试

如果你正在修改 TurboFlux 源码，可以用 `npm link` 把当前源码目录链接成全局命令：

```bash
git clone https://github.com/MengShengbo/TurboFluxCli.git
cd TurboFluxCli
npm install
npm link
turboflux --version
```

`npm link` 适合开发调试；如果只是下载后使用，优先用 `npm install -g .`。

### 常规启动

不安装全局命令，也可以在项目目录内直接启动：

```bash
npm install
npm start
```

指定工作区启动：

```bash
npm start -- /path/to/project
```

执行单次任务后退出：

```bash
npm start -- --command "summarize this repository"
```

### 常用命令

```text
/help                 查看命令
/config               查看当前配置
/config apiKey VALUE  设置本地代理令牌或模型 Key
/model                选择模型
/plan                 切换到计划/只读模式
/vibe                 切换到自主执行模式
/init                 创建 TURBOFLUX.md 项目指令
/resume               打开历史会话
```

CLI 启动时不会自动写入 `TURBOFLUX.md`。需要项目指令文件时，手动执行 `/init`。

### 本地模型代理

默认 CLI 配置：

```text
baseUrl: http://127.0.0.1:8787
apiKey: turboflux-local
model: gpt-5.5
```

启动代理：

```bash
npm run server
```

打开管理页面：

```text
http://127.0.0.1:8787/admin
```

从 `.env.example` 创建 `.env`：

```bash
TURBOFLUX_FREE_MODEL_API_KEY=<your-upstream-api-key>
TURBOFLUX_FREE_MODEL_BASE_URL=https://api.example.com/v1
TURBOFLUX_FREE_MODEL=gpt-5.5
```

如果代理绑定到非 localhost 地址，必须设置 `TURBOFLUX_PROXY_AUTH_TOKEN`。没有该 token 时，TurboFlux 会拒绝非本机绑定，避免代理被误暴露。

### 目录结构

```text
bin/           CLI 启动入口
src/cli/       Ink 终端 UI、斜杠命令、会话存储
src/core/      Agent Runtime、模型配置、权限、MCP、Skills
src/server/    本地 OpenAI-compatible 代理和管理页面
src/state/     模型与共享状态契约
src/tools/     工具执行、本地历史、记忆工具
src/shared/    跨层共享类型
docs/assets/   README 与文档资源
```

### 开发命令

```bash
npm run dev:cli        # 监听 CLI
npm run dev:server     # 监听本地代理
npm run dev            # 默认等同于 dev:cli
npm run type-check     # TypeScript 检查
npm test               # Vitest 测试
npm run build          # 编译 src/
```

### 安全设计

- 默认工具执行限制在工作区内，绝对路径和 `..` 穿越会被拦截，除非显式配置为 full access。
- 强制推送、硬重置、递归删除、数据库 drop 等高风险命令会在非 full-auto 策略下要求审批。
- 本地代理不会在管理接口中返回真实上游 API Key。
- `.env`、本地状态、构建产物、日志、临时文件、参考资料和依赖目录都应保持不入库。

### 验证命令

```bash
npm run type-check
npm test
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

---

## English

### What It Is

TurboFlux CLI is an experimental local AI workbench. It combines a terminal CLI, shared agent runtime, tool execution layer, memory utilities, checkpoint history, and a local OpenAI-compatible proxy.

It is designed for local developer workflows rather than a hosted SaaS backend.

> This public repository contains CLI and local proxy source only. Desktop source is not included.

### Architecture

```mermaid
flowchart LR
  CLI["Ink CLI\nsrc/cli"] --> Runtime["Agent Runtime\nsrc/core"]
  Runtime --> Tools["Tool Executor\nsrc/tools"]
  Runtime --> Memory["Memory + Context\nsrc/tools/memory"]
  Runtime --> MCP["MCP Client\nsrc/core/mcp"]
  Runtime --> Proxy["Local Model Proxy\nsrc/server"]
  Proxy --> Provider["OpenAI-compatible\nor upstream provider"]
  Tools --> Workspace["User Workspace"]
```

### Install From Source

Install directly from GitHub without publishing to npm:

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

Verify the global command:

```bash
turboflux --version
turboflux --help
```

Run against a workspace:

```bash
turboflux /path/to/your/project
```

Single-shot mode:

```bash
turboflux /path/to/your/project --command "summarize this repository"
```

For local development, use `npm link` instead of `npm install -g .`.

### Requirements

- Node.js 20 or newer
- npm
- Optional: `rg` / ripgrep for faster search tools

### Local Model Proxy

```bash
npm run server
```

Admin console:

```text
http://127.0.0.1:8787/admin
```

Create `.env` from `.env.example`:

```bash
TURBOFLUX_FREE_MODEL_API_KEY=<your-upstream-api-key>
TURBOFLUX_FREE_MODEL_BASE_URL=https://api.example.com/v1
TURBOFLUX_FREE_MODEL=gpt-5.5
```

If the proxy binds outside localhost, set `TURBOFLUX_PROXY_AUTH_TOKEN`.

### Development

```bash
npm run dev:cli
npm run dev:server
npm run dev
npm run type-check
npm test
npm run build
```

### Safety Notes

- Workspace tool execution defaults to a workspace sandbox.
- High-risk commands such as force pushes, hard resets, recursive deletes, and database drops require approval outside full-auto policy.
- The local proxy redacts upstream API keys from admin responses.
- Secrets, local state, build output, logs, temporary files, reference dumps, and dependencies are ignored by Git.

## License

MIT
