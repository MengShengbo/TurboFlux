# TurboFlux 沙箱

TurboFlux 将审批和沙箱视为两个独立安全层：审批决定操作是否需要用户确认，沙箱决定操作获准后能访问什么。`approvalPolicy=full` 不会关闭沙箱。

## 默认行为

默认配置是：

```json
{
  "sandboxPolicy": "workspace",
  "sandboxEnforcement": "guarded",
  "sandboxNetwork": "allow",
  "sandboxBackend": "auto"
}
```

该配置兼容各平台，但 `guarded` 只是路径、环境变量和命令入口防护，不是操作系统安全边界。运行不可信仓库或面向生产环境时应使用 `strict`。

## 策略维度

| 配置 | 可选值 | 含义 |
| --- | --- | --- |
| `sandboxPolicy` | `readonly` / `workspace` / `full` | 禁止执行和写入、仅工作区可写、显式取消文件边界 |
| `sandboxEnforcement` | `guarded` / `strict` | 进程内策略防护、要求 OS 级隔离 |
| `sandboxNetwork` | `allow` / `deny` | 允许或隔离工具进程与 Web 搜索网络 |
| `sandboxBackend` | `auto` / `guarded` / `bubblewrap` / `sandbox-exec` / `docker` | 自动选择或固定执行后端 |
| `sandboxDockerImage` | 镜像名 | Docker 后端使用的工具链镜像 |

`strict` 找不到可用后端时会禁止 Shell、后台终端和 MCP stdio 进程，不会静默回退到 `guarded`。文件读取工具仍可在工作区内使用。

## 后端

| 平台 | 后端 | 文件隔离 | 网络隔离 | 说明 |
| --- | --- | --- | --- | --- |
| Linux | Bubblewrap | 工作区外只读并隐藏用户目录 | 是 | `auto` 优先选择 `bwrap` |
| macOS | `sandbox-exec` | 工作区外禁止写入并隐藏用户目录 | 是 | 允许系统运行时文件 |
| Windows/macOS/Linux | Docker | 是 | 是 | 需要显式配置镜像；容器根文件系统只读 |
| 全平台 | Guarded | 策略检查 | 否 | 兼容模式，不应作为不可信代码的最终边界 |

Windows 当前没有内置的原生严格后端。生产配置应使用 Docker，或者在受控 Linux 执行节点上运行 TurboFlux。WSL 不会被自动当作安全边界。
Docker 镜像需要提供 Bash 以及项目所需的编译器、包管理器和 Git；仓库内的基线镜像提供 Node.js、Python、Git 与 ripgrep。

## 使用

Linux Bubblewrap：

```bash
turboflux . --sandbox workspace --sandbox-enforcement strict --sandbox-network deny
```

Docker：

```bash
docker build -f docker/sandbox.Dockerfile -t turboflux-sandbox:node .
turboflux . --sandbox workspace --sandbox-enforcement strict --sandbox-network deny \
  --sandbox-backend docker --sandbox-docker-image turboflux-sandbox:node
```

也可以持久化配置：

```text
/config sandboxPolicy workspace
/config sandboxEnforcement strict
/config sandboxNetwork deny
/config sandboxBackend docker
/config sandboxDockerImage turboflux-sandbox:node
```

重启后使用 `/sandbox` 查看实际解析出的后端和隔离状态。

## 安全边界

- 文件工具会校验工作区边界以及 symlink/junction 的真实路径。
- 前台 Shell、结构化 Git 进程、后台终端和 MCP stdio 服务共用同一进程沙箱。
- Guarded 后台终端会在完整命令行写入前重新校验，防止通过持久 Shell 绕过首次检查。
- 子进程默认不继承 API Key、Token、Cookie、认证信息、代理凭据和进程注入变量；模型也不能通过工具参数重新注入这些变量。
- 严格模式将 `HOME` 和临时目录重定向到工作区沙箱目录。
- Docker 后端使用只读根文件系统、无 Linux capabilities、`no-new-privileges`、PID/内存/CPU 限额和独立网络策略。
- Docker 任务使用独立 `cidfile`；超时、手动停止和终端销毁会按容器 ID 回收，避免只终止 CLI 后留下后台容器。
- 每次进程允许或拒绝都会写入 `~/.turboflux/audit/<workspace-hash>.jsonl`，与 Agent 可写工作区分离。审计记录只保存 SHA-256 命令摘要，不保存可能含密钥的命令正文。

`full` 是显式逃生口，不适合运行未知代码。沙箱也不能替代最小权限 API 凭据、独立部署账号、主机补丁和外部审计。
