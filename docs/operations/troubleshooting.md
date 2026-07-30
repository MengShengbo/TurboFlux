# 排障手册

## 五分钟健康检查

从仓库根目录执行：

```bash
node --version
npm run runtime:info
npm run type-check
npm run test:flow
npm run build
git status --short --branch
```

如果问题只发生在交互终端，再执行：

```bash
npm run smoke:tui
npm run baseline:terminal
```

先记录命令、平台、Node 版本、终端、工作区、错误时间和复现步骤，再修改运行数据。

## 启动或配置失败

### 症状

- CLI 启动后立即退出。
- Provider、模型或 base URL 不符合预期。
- Setup 后配置未生效。

### 检查

```bash
turboflux --version
turboflux config show
turboflux setup show
```

检查 `TURBOFLUX_CONFIG_DIR`、`TURBOFLUX_API_KEY` 和 CLI override 是否覆盖了文件配置。普通配置在 `config.json`，密钥在 `credentials.json`；查看日志或截图前先去除密钥。

用隔离配置复现可区分“用户数据问题”和“代码问题”：

```powershell
$env:TURBOFLUX_CONFIG_DIR = Join-Path $PWD '.tmp/diagnostic-config'
$env:TURBOFLUX_CONVERSATIONS_DIR = Join-Path $PWD '.tmp/diagnostic-conversations'
npm run dev:once -- .
```

## 模型请求失败

按顺序确认：

1. 活动 Provider、模型、base URL 和 context/output 上限。
2. `TURBOFLUX_API_KEY` 是否覆盖存储密钥。
3. 系统代理或 `TURBOFLUX_PROXY` 是否改变网络路径。
4. Provider 返回的是鉴权、模型不存在、参数不兼容、限流还是网络超时。
5. 错误是否发生在观察到 stream/tool 进度前；只有此前阶段适合协议候选重试。

协议兼容背景见[模型协议兼容性](../model-protocol-compatibility.md)。

## TUI 闪烁、卡顿或布局异常

先缩小变量：

```powershell
$env:TURBOFLUX_REDUCED_MOTION = '1'
$env:TURBOFLUX_DESKTOP_NOTIFICATIONS = '0'
$env:TURBOFLUX_FLOW_WINDOWING = '1'
npm run dev:once -- . --no-animation
```

收集终端尺寸、resize 行为、终端程序/版本、shell、透明模式、消息数量和是否正在高频 streaming。运行 `perf:flow` 判断数据结构回归，运行 `smoke:tui` 判断完整事件链回归。

单独关闭某个 Flow 子能力可以定位故障面，但修复后应恢复默认开启并运行完整门禁。

## 会话缺失或恢复异常

会话默认位于 `~/.turboflux/conversations/`。开始修复前：

1. 退出所有正在使用该会话的 TurboFlux 进程。
2. 复制目标 `.json`/`.jsonl` 到独立备份目录。
3. 检查最后若干 JSONL 行是否完整，每行应为单个 JSON 对象。
4. 使用 `/list` 和 `/resume` 验证索引与重放结果。
5. 保留原文件，用恢复导出生成可读证据。

读取器会保留合法前缀并把未结束 stream/tool 合成为中断状态。若追加也失败，检查文件权限、磁盘空间、目录覆盖变量和是否有另一个进程持有文件。

## 后台任务或终端残留

使用 `/ps` 查看活动 Runtime Tasks，使用 `/stop` 结束当前运行。检查：

- `.turboflux/runtime/journal.jsonl` 是否有 start 后缺少终态。
- 子进程是否响应 abort/kill。
- stdout/stderr reader 是否结束。
- owner session 是否与当前会话一致。
- Runtime 销毁时是否调用 `stopAll()` 和 `ptyKillAll()`。

重现测试优先放在 `runtimeTaskManager.test.ts`、`nodeToolExecutor.test.ts` 或 `subAgentTaskManager.test.ts`。

## MCP 连接失败

1. 确认项目或用户 `settings.json` 是合法 JSON。
2. 确认服务 `enabled: true`。
3. 启动时传入 `--mcp <name>` 或 `--mcp all`。
4. 在同一 shell 手工验证 command 和 args 能启动。
5. 检查相对路径是相对哪个工作目录解析。
6. 用 `/mcp` 查看当前服务和工具。

MCP 工具在普通审批策略下会出现确认，这是预期生命周期，不是连接失败。

## Git 集成异常

先执行只读检查：

```bash
git status --short --branch
git diff
git diff --cached
git log -5 --oneline
```

确认用户已有 staged 内容与 Agent 触及文件是否分离。结构化 commit 应显式传 paths；restore/revert 前记录 revision 和路径；push 前确认远端与分支。不要通过清理整个工作树来掩盖隔离问题。

## 代理服务

启动：

```bash
npx tsx src/server/index.ts
```

检查：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

配置 token 时添加 `Authorization: Bearer <token>`。如果服务绑定非本地地址，确认 `TURBOFLUX_PROXY_AUTH_TOKEN` 已设置；如果上游测试失败，检查 `.turboflux/server-credentials.json`、base URL 和上游 `/models` 响应。

## 提交故障报告

报告包含：

- 最小复现步骤与预期/实际结果。
- TurboFlux、Node、OS、shell 和终端版本。
- 使用的命令及去密后的有效配置。
- 最小相关日志、事件序列或 stack trace。
- `type-check`、相关测试、`smoke:tui` 的结果。
- 是否能在隔离配置和新会话中复现。

不要附带 API Key、Authorization header、完整用户会话或私有源码。
