# TurboFlux Desktop 远控架构

## 目标

Desktop 远控让用户在手机浏览器中查看和控制已授权的桌面 Agent 运行时。执行环境、工作区文件和模型凭据保留在 Desktop 主机；浏览器持有自己的设备密钥。

远程壳不是一个中心化账号系统，也不要求区块链、全球 DHT 或厂商托管服务。用户通过一次性二维码建立自己的私有信任图：电脑签发能力授权，手机用设备签名发送命令。

## 分层

```text
Desktop 远控 PWA
        │  RemoteBrowserClient
        │  RemoteClientTransport
        ├── IrohRemoteTransport（直连 / 自托管 relay）
        └── HttpRemoteTransport（受信任 HTTPS / localhost 调试入口）
                │  已签名 + E2E 加密 envelope
TurboFlux RemoteHostService
        ├── NodePairingAuthority（扫码、一次性 nonce）
        ├── RemoteHostController（能力、工作区、幂等、事件 cursor）
        ├── TurboFluxRemoteAdapter（Native WorkbenchRuntime 投影）
        └── NodeRemoteStateStore（原子保存、系统密钥库保护）
                │
        DesktopRuntimeHost / WorkbenchRuntime
```

协议层通过 `RemoteAgentAdapter` 对接 Desktop 运行时，不直接依赖 AgentEngine。

## 配对与授权

1. 电脑生成 Ed25519 签名密钥、X25519 密钥和短期 QR invite。
2. 手机验证电脑身份签名，生成自己的设备密钥并签名 response。
3. 电脑验证 response 的 invite ID、nonce、能力子集和有效期。
4. Desktop 展示设备名、设备指纹、能力与工作区；用户明确批准后才进入下一步。
5. 电脑持久化授权并签发 capability grant，包含能力列表、工作区 ID allowlist 和过期时间。
6. 后续每个命令都带 grant ID、command ID 和创建时间；同一设备重复 command ID 返回缓存或持久化结果。

`workspaceIds` 为空表示用户明确授予 host-wide 权限；非空时，快照、事件和命令都必须落在 allowlist 内。桌面端默认只授予当前工作区。

## 加密封装

每个 envelope 使用临时 X25519 密钥、HKDF-SHA-256 和 AES-256-GCM。AAD 固定包含协议版本、消息 ID、双方设备 ID、时间戳、临时公钥和 IV。整个 envelope 再由发送设备 Ed25519 签名。

因此：

- relay、HTTPS 反向代理和网络观察者看不到命令、会话正文或产物内容；
- 篡改、错误收件人、过期消息和重放会被拒绝；
- 私钥不会进入远程 DTO。Native adapter 会去掉原始工作区路径、隐藏 system turn、API 配置和运行时内部对象；产物只能通过工作区内、限长、分块读取。

## 传输策略

当前可用传输：

- `RemoteHttpGateway`：只绑定 `127.0.0.1`，供受信任 HTTPS 反向代理转发；Host 与 Origin 使用公开端点和控制页配置生成 allowlist，明文 HTTP 只允许 localhost 联调。
- `IrohRemoteEndpoint` / `IrohRemoteTransport`：接受宿主注入的 byte channel；仓库没有提供原生 Iroh endpoint。

浏览器客户端使用受信任 HTTPS 反向代理。LAN IP 明文 HTTP 不具备浏览器安全上下文，即使业务 envelope 已加密也不能作为真机 Web 发布入口。

## 威胁模型

| 威胁 | 防护 | 当前边界 |
| --- | --- | --- |
| 中继/网关读取内容 | AES-GCM + 设备签名 | 端点元数据（时间、大小、IP）仍可见 |
| 配对码被截获 | 短 TTL、nonce、单次消费、设备指纹与 Desktop 二次确认 | 用户仍需核对设备名和指纹，拒绝陌生请求 |
| 已配对手机丢失 | 桌面端单设备撤销、grant 过期 | 撤销需要用户能进入桌面端设置 |
| 重放旧命令 | envelope message ID replay window + in-flight 合并 + 持久化 command ledger | 崩溃时处于 in-progress 的命令返回 outcome unknown，绝不自动重跑 |
| 越权访问其他工作区 | grant workspace allowlist + adapter workspace resolver | host-wide grant 是显式高权限选择 |
| 产物路径泄露或任意文件读 | 工作区 containment、manifest、分块上限 | 允许的产物内容本身仍由用户授权发送到手机 |
| 恶意第三方 adapter | descriptor 能力检查、独立 adapter 边界 | adapter 代码仍与桌面进程同权限，生产环境需插件沙箱 |
| HTTP CSRF / DNS rebinding | loopback bind、Host/Origin allowlist、设备签名和 grant | 生产仍需 HTTPS、速率限制和反向代理请求体上限 |

## 当前实现

当前源码覆盖设备密钥、Desktop 二次确认、二维码配对、事务式持久化授权、跨重启命令幂等、同信封网络重试、工作区隔离、跨工作区定向提交与控制、会话和事件同步、纠偏、审批、暂停、继续、停止、产物分块读取、Node 与浏览器加密互操作，以及自托管 HTTPS 端点。

部署与设备配对见[Desktop 远控运行说明](remote-shell-runbook.md)。
