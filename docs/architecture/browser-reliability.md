# 内置浏览器执行与验收

这次改动位于 Desktop 的 Electron 浏览器能力层及共享 MCP 结果协议。Agent 继续操作用户能看到的 WebContentsView，复用现有会话隔离与权限流程；没有引入第二套浏览器进程或新的运行时依赖。

## 责任与调用链

`Agent → MCP browser tools → SerializedOperationCoordinator → BrowserRuntime → BrowserSystem → WebFrameMain / Chromium debugger`

| 模块 | 责任 |
| --- | --- |
| `browserSystem.ts` | 标签页、生命周期、操作语义、前置条件、执行记录和结果验证 |
| `browserRuntime.ts` | 执行上下文、取消传播、单命令 5 秒和工具 60 秒的上限、错误恢复提示 |
| `browserDebugger.ts` | 每个页面的调试器串行租约，避免截图、输入、上传相互断开连接 |
| `browserDom.ts` | 真实节点引用、可访问名称、开放 Shadow DOM、可交互性、计算样式检查 |
| `browserNavigation.ts` | 导航、前进后退、刷新、DOM 就绪、关闭/崩溃/失败和监听器清理 |
| `browserSession.ts` | 按会话的权限策略、下载归属和网络诊断 |
| `browserCapture.ts` | 原生页面稳定视口截图与图像附件 |
| `browserCapability.ts` | Agent 的观察、操作、核验、修复和恢复约定 |

## 不变条件

1. 元素 ref 同时绑定标签实例、观察代次、frame 身份和实际 DOM 节点。观察过程中导航会使结果失效；只读观察允许有限重试。节点被 clone、替换或改成另一个语义目标，旧 ref 不能继续使用。
2. 点击检查可见、启用、稳定和未遮挡。鼠标移动后再次核验，防止 hover 产生的遮挡改变点击对象。原生点击不会自动补一次 DOM 点击；双击发送两组原生按下/抬起。
3. 输入、选择、勾选验证目标类型和可修改状态。不存在或禁用的选项在修改前失败；相同勾选状态不重复发出 change。
4. 取消或超时会解除挂起的工具等待，后续延迟续体在继续下发命令前检查上下文。已送进 Chromium 的命令无法保证撤回，因此不能自动重放提交、删除、上传等动作。错误结果包含 `code`、`recovery` 和 `retrySafe`。
5. `dispatched` 只说明指令发出，不代表用户目标完成。`assert` 支持延迟重试、否定预期与字段值检查；失败以 MCP `isError: true` 传给 Agent，并在执行记录里记为失败。
6. 页面崩溃或停止响应后，显式 reload 会替换 WebContentsView，保留标签 ID、会话 partition、保留策略与 URL 浏览历史。旧页面的迟到事件不能删除或覆盖新页面。历史恢复不重放序列化的 POST/表单状态。
7. 页面触发的导航、iframe 导航和重定向使用原始 URL 协议验证，不能把危险协议误解释为搜索词。无归属的下载被阻止。上传仍限制在工作区真实路径内。

本机故障注入曾复现：强制崩溃再直接 reload 后，Electron 主 frame 仍标为 detached，页面可以显示但 CDP 输入不能正常完成。最终实现采用页面实例重建，没有放宽 detached 引用检查。

## Agent 修改网页后的自我审查

- 在内置浏览器复现问题，使用 `inspect` 获取尺寸、遮挡、启用/可编辑状态和关键计算样式，使用 `diagnostics` 读取控制台和失败请求。
- 用 `visual_observe` 获取真实截图；DOM 文本不能证明视觉布局正确。
- 通过现有文件工具修改对应工作区源码。临时修改页面 DOM 不算修复源码。
- reload 同一标签，重新观察获得新 ref，重复原来的操作，通过 `assert` 核验目标状态，再检查新截图。
- 覆盖受影响的宽窄布局和交互。失败效果不确定时先检查是否已经发生，重复失败时报告具体证据。

`inspect` 和 MCP 断言结果是这条链路的工具支持；Agent 指令本身不是模型一定会遵循的证明。当前验证覆盖真实 MCP 工具链，没有运行带实际模型的端到端自主修复评测。

## 验证入口

运行 `npm run qa:browser`。脚本编译真实 BrowserSystem 源码，在独立临时 profile 中启动可见 Electron 窗口、主页面和跨域 iframe，经真实 MCP 客户端调用工具。测试不使用用户的登录会话。

默认证据目录为 `apps/desktop/generated/browser-qa/`；可用 `TURBOFLUX_BROWSER_QA_OUTPUT` 设置独立目录。输出包括 `report.json`、桌面与窄视口截图；失败时输出 `failure.json`。

验证场景包括：标签与 Shadow DOM 识别、原生 Enter 提交、选择失败无副作用、勾选幂等、只读/禁用/密码保护、精确单双击、遮挡阻止与等待、节点替换、跨域 frame 操作、键盘、上传下载、画布、异步断言、诊断脱敏、截图、取消与队列恢复、跨标签 ref 拒绝、挂起子资源、导航取消、协议阻止、历史、崩溃恢复及任务清理。

CI 的 macOS Desktop 测试任务已增加该入口和证据上传。这里只完成了本机 macOS 原生验证；不把未执行的 Windows/Linux 验证或未来 CI 结果算作通过。

## 能力边界

- 支持开放 Shadow DOM；关闭的 shadow root 不支持。名称推导覆盖常用标签和 ARIA 命名，不是完整无障碍树审计器。
- iframe 保持 frame 范围内的语义操作；未实现跨域 frame 原生可信坐标输入、iframe 文件上传。
- 不提供任意页面脚本执行给模型，不绕过登录、验证码或网站权限。密码仍需用户手动填写。
- 坐标操作依赖当前视口证据；动画、滚动、缩放、布局变化后应重新截图。未实现将坐标参数强制绑定截图代次。
- 页面注入代码与 DOM 共享页面环境，不应被当作对恶意页面的完整隔离层。页面内容始终属于不可信数据。

## 官方资料及采用点

调研通过直接获取官方文档完成；搜索工具在本次运行中未返回可用正文。原始文档和提取文本保存在工作区外层的 `artifacts/browser-reliability-20260919/research/`。

| 官方资料 | 采用点 |
| --- | --- |
| Playwright Actionability | visible、stable、receives events、enabled、editable 前置检查；等待条件而非固定睡眠后盲点 |
| Playwright Locators | 优先用户可见标签和 role、开放 Shadow DOM、动态页面重新定位 |
| Playwright Assertions | 有上限的断言重试；执行成功和状态符合预期分开 |
| Electron WebContents / WebFrameMain | frame 生命周期、导航事件、renderer crash、unresponsive、detached |
| Electron Debugger | 调试器附着/断开、命令失败与资源生命周期 |
| Electron Security | sandbox、contextIsolation、权限处理、导航/新窗口边界 |

资料地址：

```text
https://playwright.dev/docs/actionability
https://playwright.dev/docs/locators
https://playwright.dev/docs/test-assertions
https://www.electronjs.org/docs/latest/api/web-contents
https://www.electronjs.org/docs/latest/api/web-frame-main
https://www.electronjs.org/docs/latest/api/debugger
https://www.electronjs.org/docs/latest/tutorial/security
```
