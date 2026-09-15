# Desktop 远控运行说明

## 安全边界

Desktop Remote gateway 默认只监听 `127.0.0.1:48173`。手机浏览器必须通过受信任证书保护的 HTTPS 反向代理连接；本机联调可使用 loopback 地址：

- 受信任证书保护的 HTTPS 反向代理；
- 同一台电脑上的 `localhost` / `127.0.0.1` 调试入口。

不要让反向代理跳过 TLS，也不要把 gateway 端口直接映射到公网。HTTPS 保护页面、安全上下文和入口元数据；设备签名与 E2E envelope 进一步保护命令、会话正文和产物内容。

Desktop 必须能够使用 Electron `safeStorage` 保护主机身份、设备授权和幂等账本；系统安全存储不可用时会拒绝启用远控，而不是退化为重启即失效的内存模式。

## 开发联调

```bash
npm install
npm run build:remote
```

Desktop 会托管 `apps/remote-mobile/dist`。本机浏览器可打开设置中显示的 `http://127.0.0.1:<port>`，但手机不能使用这个地址，也不能使用电脑的私网 IP 明文访问。

## HTTPS 部署

1. 准备一个受信任 HTTPS 域名和反向代理。
2. 将该域名的所有路径转发到设置中显示的本机调试地址。
3. 保留原始 `Host`、正确的请求体上限和合理的连接超时。
4. 在“手机远程”中保存“HTTPS 公开端点”。
5. 如果控制页独立部署，再填写“Web 控制页 URL”；否则留空，直接使用公开端点托管的页面。
6. 启用手机远程并生成二维码。

Gateway 只接受 loopback Host、配置的公开端点 Host，以及同源或配置控制页的 Origin。修改公开端点或控制页 URL 会立即刷新 allowlist，并废止尚未完成的旧配对邀请。

## 配对流程

1. Desktop 生成五分钟有效的一次性二维码。
2. 手机验证主机签名，创建本地设备密钥并提交签名配对响应。
3. Desktop 显示设备名称、设备指纹、能力和当前工作区。
4. 用户核对后点击“允许”；未经确认不会签发 capability grant。
5. 手机保存加密后的设备身份和授权，后续命令全部走签名 E2E envelope。
6. “撤销”立即移除单台设备；“停止本次远控”撤销全部设备、待确认请求和活动控制租约。

配对码只允许放在 URL fragment（`#pair=...`）中，因此不会随页面请求发送到服务器，并会在页面脚本启动后立即从地址栏移除。查询参数形式（`?pair=...`）会被拒绝且不会进入离线缓存；由于它可能已经出现在服务器访问日志中，用户必须回到 Desktop 重新生成二维码。

## 权限与可靠性

- 默认授权只覆盖配对时的当前工作区和固定能力白名单，有效期 12 小时。
- 只读快照和事件同步无需独占租约；变更运行时的命令必须持有 `session.control` 能力和 30 秒滚动控制租约，其他控制页面必须显式接管。
- 配对批准后按实际批准时间验证 grant，等待确认不会错误沿用二维码打开时的旧时间。
- 网络响应丢失时，客户端重发同一加密 envelope；Host 返回缓存结果，不重复执行命令。
- 移动端人工重试提交时复用原 `commandId`，直到收到确定结果或用户修改提交内容。
- 暂停、继续和停止按目标会话定向执行；跨工作区时 Desktop 串行切换运行时并再次确认目标。
- 手机启动时如果电脑离线或 HTTPS 入口暂时不可达，会保留已配对的设备密钥；只有授权撤销、过期或已保存状态确认损坏时才要求重新配对。

## 发布检查

```bash
npm --prefix packages/remote-protocol test
npm --prefix packages/remote-protocol run type-check
npm --prefix apps/remote-mobile test
npm --prefix apps/remote-mobile run type-check
npm --prefix apps/remote-mobile run build
npm --prefix apps/desktop run type-check
npm --prefix apps/desktop run build:app
```

正式发布还应在真实 HTTPS 域名和真机浏览器中完成扫码、延迟批准、响应丢失重试、双标签页接管、跨工作区控制、撤销和恢复验收。
