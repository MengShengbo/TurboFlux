# 测试策略

## 目标

测试体系同时保障领域正确性、崩溃恢复、终端交互质量、跨平台行为和构建可发布性。默认从最小相关测试开始，再逐级扩大验证范围。

## 分层

| 层 | 范围 | 典型位置 | 主要风险 |
| --- | --- | --- | --- |
| 纯单元 | reducer、parser、selector、helper | 与实现共址的 `*.test.ts` | 边界值、状态转换、格式兼容 |
| 服务单元 | Runtime、权限、会话、模型、工具 | `src/core/**/*.test.ts`、`src/cli/conversations/` | 生命周期、取消、重放、并发 |
| 组件 | Ink 组件和交互模型 | `src/cli/components/**/*.test.tsx` | 可见状态、输入、overlay、窗口化 |
| Golden Trace | 跨事件序列 | `src/cli/state/goldenTraces.test.ts` | 事件顺序和恢复后的等价状态 |
| Smoke | 完整 headless TUI | `scripts/tui-flow-smoke.ts` | 启动、输入、渲染、完成和落盘 |
| 性能 | reducer、调度、渲染数据结构 | `scripts/flow-performance.ts` | 长会话退化、增量突发、窗口化 |
| 平台矩阵 | Windows/macOS/Linux | GitHub Actions | shell、路径、终端和进程差异 |

## 快速验证

单文件：

```bash
npx vitest run src/core/runtime/sessionRegistry.test.ts
```

单目录：

```bash
npx vitest run src/cli/state
```

类型与相关测试：

```bash
npm run type-check
npm run test:flow
```

完整门禁：

```bash
npm run ci:flow
```

## `ci:flow` 顺序

当前脚本固定执行：

1. `npm run type-check`
2. `npm test`
3. `npm run perf:flow`
4. `npm run smoke:tui`
5. `npm run build`

GitHub Actions 在 `ubuntu-latest`、`windows-latest` 和 `macos-latest` 上用 Node.js 20、`npm ci` 执行同一门禁。专项命令和 CI 必须复用相同脚本，避免本地与远端逻辑分叉。

## 生命周期测试矩阵

涉及 Run、Tool、Approval、Runtime Task、SubAgent 或 Conversation 时至少覆盖：

| 场景 | 期望 |
| --- | --- |
| 成功 | 只产生一个完成终态，资源释放 |
| 业务失败 | 错误分类稳定，部分输出按契约保留 |
| 用户取消 | signal/kill 传递，状态为 cancelled/interrupted |
| 超时 | 进程和 reader 都结束，不遗留 pending promise |
| 重复事件 | reducer/manager 幂等或明确去重 |
| 进程中断 | JSONL 可重放，未完成项合成为中断终态 |
| 损坏尾部 | 保留合法前缀，后续仍可追加 |
| 会话切换 | 运行中被 guard 阻止，空闲时所有 owner 一致更新 |

## 文件与命令测试

- 使用系统临时目录创建工作区，不接触用户仓库。
- 同时覆盖 POSIX 和 Windows 风格路径输入。
- 校验符号链接/最近存在祖先后的包含关系。
- 写入测试覆盖 optimistic version 或并发修改保护。
- 子进程测试保证 stdout/stderr、exit、timeout、abort 和 kill 都能收敛。
- 测试结束检查监听器、PTY、server 和 timer 已释放。

## 会话恢复测试

Conversation Journal 测试应构造真实事件行，不 mock 掉重放逻辑。关键夹具包括：

- legacy snapshot + 新 JSONL。
- 流式 answer/thinking 中断。
- tool call 已记录但 result 缺失。
- queue、draft、steer 和 approval v2 状态。
- 不完整最后一行和中间非法行。
- compact 后旧增量不再影响当前状态。

## TUI 与终端

组件测试关注语义状态，不绑定不稳定的整屏快照。完整终端行为交给 `smoke:tui` 和 `baseline:terminal`：

- 终端尺寸和 resize。
- ANSI 颜色、透明模式、低动态模式。
- 长 transcript 窗口化。
- 高频流式增量与输入响应。
- 审批 modal、queued prompt 和后台完成通知。

如果修复特定终端问题，在 `terminalBaseline` 中记录平台、架构、Node、终端程序/版本、transport、shell basename、TTY 几何和 CI 标记，不记录用户内容。

## 性能回归

`perf:flow` 是结构性能门禁，不替代真实终端 SLO。修改 reducer、selector、调度器、windowing 或 Markdown 渲染时：

1. 先运行专项单元测试。
2. 运行 `npm run perf:flow` 并对比基线。
3. 运行 `npm run smoke:tui` 确认真实事件链。
4. 对交互可见变化补终端基线证据。

不要通过放宽阈值掩盖算法退化；阈值变化应附测量环境和原因。

## 测试数据规则

- API Key 使用显式测试占位值。
- 不读取用户 home 下的真实配置、会话或凭据。
- 不把用户提示词、源码内容或密钥写入快照和遥测夹具。
- 时间敏感逻辑注入 clock；ID 敏感逻辑注入 factory。
- 随机/并发测试必须可复现，失败输出包含 seed 或事件序列。

## 新增质量门禁

门禁必须满足：跨平台可执行、耗时可接受、失败信息可行动、本地有同名脚本。新增脚本后更新 `package.json`、GitHub Actions、本页和发布手册。
