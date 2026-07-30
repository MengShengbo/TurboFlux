# TurboFlux 开发者心流运维手册

> 适用范围：Flow v2、审批/输入协调、会话恢复、stream 调度、transcript windowing、通知 inbox 与本地 flow telemetry。
>
> 状态：2026-07-29 实施版。结构门禁、Flow 语义 UI、degraded recovery、平台注意力、reduced-motion、分块回退和终端基线工具已建立；真实物理 paint、通知送达与发布周期证据仍需外部验收。

## 1. 值班目标

这套系统的首要目标不是让动画更平滑，而是保证四件事：用户输入不静默丢失、审批不会永久悬挂、有副作用操作不越过能力边界、后台结果在确认前不消失。

发生异常时按以下优先级处理：

1. **P0：** capability escape、未授权副作用、审批批准后永久悬挂、critical journal 无法落盘却仍继续执行。
2. **P1：** prompt/steer 丢失、错误后 queue 自动运行、会话 owner 混淆、恢复后重复执行。
3. **P2：** 长 transcript 卡顿、stream backlog、ghost modal、通知重复或 paste/IME 误提交。
4. **P3：** 文案、颜色、spinner 节奏和不影响控制权的视觉问题。

## 2. 五分钟健康检查

在仓库根目录执行：

```powershell
npm run type-check
npm run test:flow
npm run perf:flow
```

准备发布时执行完整门禁：

```powershell
npm run ci:flow
```

`ci:flow` 依次运行 type-check、全部 Vitest、flow 性能门禁、真实 PTY smoke 和 TypeScript build。CI 在 Ubuntu 与 Windows 上执行同一命令，配置见 [flow-quality.yml](../.github/workflows/flow-quality.yml)。

判定原则：

- 任一 correctness / recovery / capability 测试失败，停止发布。
- 性能脚本失败，先确认是否为稳定回退；不要通过放宽阈值掩盖算法退化。
- 微基准通过只证明结构预算；stdout flush 指标证明字节已交给终端流，但仍不等同于终端模拟器完成物理 paint。

## 3. 可观测面与数据位置

| 数据 | 默认位置 | 用途 | 内容边界 |
| --- | --- | --- | --- |
| Flow telemetry | `<workspace>/.turboflux/telemetry/flow-metrics-v1.json` | reducer、stream、window、cache、journal 聚合指标 | 固定 metric 名和数值，不含 prompt、回答、命令、文件内容或绝对路径 |
| Conversation journal | `$env:TURBOFLUX_CONVERSATIONS_DIR/<id>.jsonl`，未设置时为用户目录下 `.turboflux/conversations/<id>.jsonl` | 会话、stream、工具、queue、draft、steer、approval 恢复 | 含会话内容，按敏感数据处理 |
| Legacy conversation | 同目录 `<id>.json` | v1 向前兼容 | 含会话内容 |
| Runtime task journal | `<workspace>/.turboflux/runtime/journal.jsonl` | 后台终端/任务 owner、PID、终态与恢复 | 可能含命令和日志路径，按敏感数据处理 |
| Runtime task log | `RuntimeTask.logPath` 指向的位置 | 后台命令输出 | 可能含命令输出、凭据或项目数据 |

不要把 conversation journal、runtime journal 或 task log 当作普通遥测上传。排障共享前先做内容和绝对路径脱敏。

### 3.1 遥测开关

当前进程禁用本地 flow telemetry：

```powershell
$env:TURBOFLUX_TELEMETRY='0'
npm run dev:once
```

恢复默认行为时启动新进程并移除该环境变量。禁用 telemetry 不会禁用 journal；两者用途不同。

### 3.2 Flow UI 回滚开关

Flow selectors 始终驱动 Agent 执行状态。若增强 Flow 提示在某个终端上出现异常，可仅关闭增强展示：

```powershell
$env:TURBOFLUX_FLOW_UI='0'
npm run dev:once
```

该开关不关闭 FlowStore、AgentFlowController、journal、审批 coordinator 或 capability gate，也不会切换到第二套状态 owner。恢复时移除环境变量并启动新进程。

### 3.3 分块回退与注意力开关

所有开关只在进程启动时读取；修改后必须重启。核心可逆块如下：

| 环境变量 | `0` 时的回退 | 不会关闭 |
| --- | --- | --- |
| `TURBOFLUX_FLOW` | 同时关闭下列五个 Flow 展示/性能块 | approval、capability、journal safety gate |
| `TURBOFLUX_FLOW_UI` | 关闭增强状态语义和输入回执 | FlowStore、AgentFlowController 与 selectors |
| `TURBOFLUX_FLOW_WINDOWING` | `WindowedMessageList` 回退到完整 `MessageList` | transcript 内容 |
| `TURBOFLUX_FLOW_NOTIFICATIONS` | 关闭 inbox/title/desktop 通知，保留 inline action | 审批事实与 modal |
| `TURBOFLUX_FLOW_STREAM_SCHEDULER` | adaptive batch 回退为即时可见更新 | stream 内容 |
| `TURBOFLUX_FLOW_JOURNAL_BATCHING` | streaming batch 回退为同一 writer 即时写 | journal 持久化与 degraded gate |
| `TURBOFLUX_DESKTOP_NOTIFICATIONS` | 只关闭 OS 桌面通知 | inbox、terminal title |

`TURBOFLUX_REDUCED_MOTION=1` 会关闭启动揭示、spinner 轮播和 typewriter，但保留静态状态文本。桌面通知只在终端通过 focus reporting 明确报告失焦时发送；未知焦点状态保持安静，且通知只包含固定分类文案。

### 3.4 Metric 解释

| Metric | 类型 | 运维含义 |
| --- | --- | --- |
| `ui.key_received` | counter | composer 收到的用户活动次数；不是按键内容 |
| `ui.key_to_terminal_flush_ms` | histogram | 编辑内容变化到对应 Ink 帧写入 stdout 并完成 stream callback 的时间 |
| `ui.submit_to_echo_flush_ms` | histogram | 提交动作到乐观输入/本地结果所在帧完成 stdout flush 的时间 |
| `ui.delta_to_tail_flush_ms` | histogram | stream delta 到可变 tail 所在帧完成 stdout flush 的时间 |
| `ui.frame_render_ms` | histogram | Ink 生成单帧输出的 CPU 时间；不包含 stdout callback 等待 |
| `ui.approval_requested` | counter | 审批/输入请求事实数 |
| `ui.approval_presented_ms` | histogram | 请求到 modal 展示的等待；主动输入期间约 1 秒是设计行为 |
| `ui.stream_flush` | counter | 合并后的可见 stream flush 次数 |
| `ui.stream_batch_depth` | histogram | 每次 flush 合并的 delta 数 |
| `ui.stream_oldest_age_ms` | histogram | flush 时最老 delta 的年龄 |
| `ui.transcript_mounted_cells` | histogram | 当前实际 mount 的 transcript cell 数 |
| `ui.transcript_total_cells` | histogram | transcript 总 cell 数 |
| `ui.markdown_cache_hit_rate` | histogram | 进程结束时 cache 命中百分比，范围 0–100 |
| `journal.physical_writes` | counter | 物理 journal 写次数 |
| `journal.streaming_batches` | counter | stream 批量落盘次数 |
| `flow.reducer_violation` | counter | reducer 非法转移或 invariant 违规数 |

当前文件是累计快照，不是带时间维度的 tracing 系统。三个 `*_flush_ms` 指标比结构微基准更接近真实交互，但不包含终端模拟器接收字节后的栅格化/显示延迟。比较两个版本时使用相同任务、终端、Node 版本和数据规模，并保存独立快照。

### 3.5 终端矩阵基线

先完成一次真实交互会话并正常退出，让 telemetry flush。每个矩阵格分别运行：

```powershell
npm run baseline:terminal -- --label "Windows Terminal / ConPTY" --transport conpty --probe-ack 30 --output .turboflux/baselines/windows-terminal.json
npm run baseline:terminal -- --label "SSH" --transport ssh --probe-ack 30 --output .turboflux/baselines/ssh.json
```

报告严格区分三层证据：

1. `stdoutFlush`：应用事件到 stdout callback；自动采集，但不是物理 paint。
2. `terminalAck`：`--probe-ack` 的 ANSI DSR 往返；证明终端处理了查询，仍不是物理 paint。
3. `physicalPaint`：高帧率摄像或平台 compositor instrumentation 的外部数据。

复制并填写 [物理 paint 证据模板](./terminal-paint-evidence.example.json) 后执行最终判定：

```powershell
npm run baseline:terminal -- --label "Windows Terminal / ConPTY" --transport conpty --paint-evidence .turboflux/baselines/windows-paint.json --strict
```

模板中的 `-1` 是故意设置的失败占位符；不得用 stdout/DSR 数值替换它并冒充物理 paint。自动采集部分只输出环境白名单和数值，不记录 session ID、SSH endpoint、prompt、命令或绝对路径；`label`、外部 evidence 的 `method/notes` 是操作者提供字段，共享前仍需检查。

## 4. 用户操作面

### 4.1 后台结果 inbox

- `/inbox`：列出尚未确认的 `result-ready` 项。
- `/inbox clear`：确认并清除已查看的后台结果。
- 状态栏 `inbox:<count>`：表示待确认结果数。
- 清空 inbox 只确认展示结果，不会删除 conversation journal 或 runtime task journal。

### 4.2 能力边界

- `/capability`：查看当前 profile。
- `/capability read-only`：应急收敛到 workspace 内只读，并阻止命令和写入。
- `/capability workspace-write`：允许 workspace 内读写，阻止 host 命令和外部路径。
- `/capability danger-full-access`：允许 host 命令和 workspace 外路径，状态栏持续显示 `cap:danger-full-access!`。

Approval 只决定“何时询问”，capability 决定“是否允许”。不要通过放宽 approval policy 处理 capability 错误。

### 4.3 后台终端

- `/ps`：查看受管后台终端、PID、退出码、持续时间和恢复状态。
- `/stop <session-id>`：停止当前 runtime 可控制的会话。
- 恢复出的 live process 是 observable/read-only；必要时按列出的 PID 通过操作系统处置。

### 4.4 Flow 安全恢复

- `/flow status`：查看 persistence health、待恢复 entry 数和本进程分块开关。
- `/flow export [路径]`：导出非覆盖、常见凭据脱敏的只读恢复包；不修改原 journal。
- `/flow retry`：修复磁盘/权限后显式重试保留的失败 entry，并重新执行 durable snapshot。
- degraded 期间普通 prompt、steer、queue 启动和模型型命令均被阻止，编辑器内容保持不变；`/flow`、`/help` 与退出命令仍可用。

## 5. 故障手册

### 5.1 Conversation journal degraded

**症状**

- composer 上方出现“会话历史不可用”；
- 新提交或审批在 critical write 处失败；
- `.jsonl` 无增长、磁盘满、权限错误或安全软件拦截 rename/write。

**检查**

1. 确认 `TURBOFLUX_CONVERSATIONS_DIR` 是否指向预期目录。
2. 检查磁盘空间、目录权限、只读挂载和文件锁。
3. 只读查看 journal 尾部；损坏尾行可由 replay 忽略，但不要直接删除文件。
4. 运行 `npx vitest run src/cli/conversations/journalWriter.test.ts src/cli/conversations/store.test.ts`。

**控制与恢复**

1. 不要清空编辑器；全局 persistence gate 已阻止新的 Agent 副作用。运行 `/flow status` 核对 pending recovery 数。
2. 先运行 `/flow export .turboflux/recovery/incident.json` 保存脱敏恢复证据；目标已存在时命令会拒绝覆盖。
3. 修复磁盘空间、目录权限、只读挂载或文件锁后运行 `/flow retry`。
4. 再运行 `/flow status`，只有显示 `healthy` 后才允许新的 Agent run；失败 entry 会按原顺序写回。
5. 若 retry 仍失败，保留原 journal 与恢复包并升级为 P0/P1；不要用 `/new` 绕过门禁。

### 5.2 审批悬挂或 ghost modal

**症状**

- Action Required 长时间存在但没有 modal；
- 批准第一项后第二项不出现；
- request 已取消但旧 modal 突然出现。

**检查**

1. 若用户仍在输入，modal 延迟到最后输入后 1 秒属于正常行为。
2. 运行 `npx vitest run src/core/runtime/approvalCoordinator.test.ts src/core/agentEngine.approval.test.ts src/cli/state/approvalPresentationScheduler.test.ts`。
3. 观察是否存在稳定 `requestId`，以及 lifecycle 是否到达 `resolved` 或 `cancelled`。

**控制与恢复**

1. 使用 Ctrl+C abort 当前 run；Coordinator 应结算全部 pending request。
2. 不要重复提交同一审批决定，也不要手工调用 tool side effect。
3. 重启后，未完成审批只作为历史恢复，不自动执行。
4. 若两个并行请求仍错配，按 P0 处理并保留事件顺序、requestId 和脱敏 tool 名。

### 5.3 `flow.reducer_violation` 增长

**症状**

- telemetry 中 reducer violation counter 增加；
- busy/action/queue 等 selector 出现无法由合法事件序列解释的状态。

**检查**

1. 记录发生前的用户动作类别：submit、steer、queue、approval、abort、session switch。
2. 运行 `npx vitest run src/cli/state/flowReducer.test.ts src/cli/state/goldenTraces.test.ts`。
3. 检查 violation reason、event type、thread ID 与 item/run identity 是否完整。

**控制与恢复**

1. 停止继续提交受影响线程的新输入，保留脱敏事件类型、identity 和 violation reason。
2. 将最小事件序列补成 reducer test 或 Golden Trace；不要在 React 层增加补丁状态。
3. 修复 reducer/controller 转换后重跑 `test:flow` 与真实 TUI smoke，确认 violation 不再增长。

### 5.4 长 transcript 卡顿或 resize 抖动

**症状**

- 10k 行附近输入延迟；
- resize 后 scroll anchor 跳动；
- mounted cells 接近 total cells；
- Markdown cache 命中率显著下降。

**检查**

1. 执行 `npm run perf:flow` 并保存 JSON 输出。
2. 对比 `ui.transcript_mounted_cells` 与 `ui.transcript_total_cells`；前者应保持有界。
3. 检查是否频繁改变 width、thinking/tool detail，导致高度 cache 重建。
4. 运行 transcript 与 Markdown 定向测试。

```powershell
npx vitest run src/cli/components/transcriptWindowing.test.ts src/cli/components/TranscriptViewport.test.ts src/cli/components/markdown/index.test.ts
```

**控制与恢复**

1. 用 `/new` 开启新会话，旧 journal 保留；这是临时缓解，不是修复。
2. 不要直接扩大 overscan 或 cache 上限；先确认 cell 高度估计和 selection pin。
3. 若结构门禁通过但真实终端仍卡顿，记录终端、列数、Node 版本和 key-to-paint trace，按“真实 SLO 缺口”处理。

### 5.5 Stream backlog 或输出吞吐异常

**症状**

- `ui.stream_oldest_age_ms` 持续高；
- batch depth 增长但 flush 无增长；
- catch-up/smooth 频繁切换。

**检查与恢复**

1. 运行 `npx vitest run src/cli/state/adaptiveStreamScheduler.test.ts`。
2. 检查输入活动是否不断延长 input-priority window。
3. 检查主线程是否被同步 I/O、Markdown 或全量 render 占用。
4. 不要仅缩短 delay；先移除阻塞源，再用相同 burst 复测。

### 5.6 Windows paste / IME 误提交

**症状**

- 非 bracketed paste 中的 Enter 提前提交；
- CJK/emoji 光标拆分字符；
- 普通慢速输入被误判为 paste burst。

**检查与恢复**

1. 运行 `npx vitest run src/cli/components/input/terminalInputStateMachine.test.ts src/cli/components/input/PromptInput.test.ts`。
2. 记录终端模拟器、是否启用 bracketed paste、输入法和 key event 间隔。
3. 导航键或带 modifier 的输入会重置 burst state；可用一次导航操作结束异常分类。
4. 调整 `charIntervalMs`、`minimumBurstChars` 或 `newlineGuardMs` 前必须补平台 trace，不按单一终端拍脑袋改全局值。

### 5.7 Session / owner 混淆

**症状**

- 切换 conversation 后后台结果出现在错误会话；
- runtime task owner 在 switch 后改变；
- 新会话复用旧 queue/draft。

**检查与恢复**

1. 用 `/list`、`/resume` 与 `/ps` 核对 conversation ID 和 runtime session ID。
2. 运行 `npx vitest run src/core/runtime/sessionRegistry.test.ts src/core/runtime/agentRuntime.test.ts src/cli/conversations/manager.test.ts`。
3. 不要在 UI、ConversationManager 和 AgentRuntime 分别生成新 ID；所有激活必须经过 `SessionRegistry` guard。
4. 发现错误归属时停止相关后台任务，保留 runtime journal，并按 P1 处理。

### 5.8 Capability violation

**症状**

- workspace-write 访问绝对外部路径、`..`、symlink/junction escape、跨盘符或 UNC；
- read-only 执行写入或命令；
- danger-full-access 未持续显示。

**控制与验证**

1. 立即切换 `/capability read-only` 并停止当前 run。
2. 保留脱敏 tool 名、profile、原始/解析后路径类别和平台；不要共享真实敏感路径。
3. 运行 capability 与 executor 测试。

```powershell
npx vitest run src/core/runtime/capabilityBoundary.test.ts src/core/runtime/nodeToolExecutor.test.ts
```

4. 任一 escape 视为 P0；不要用新增 approval prompt 代替 capability 修复。

## 6. 发布与回滚

### 6.1 发布门禁

发布前必须保留以下证据：

1. `npm run ci:flow` 成功输出；
2. 12 条 Golden Trace 目录完整且全部通过；
3. `npm run perf:flow` 的 JSON 和执行平台；
4. `git diff --check` 无本轮新增 whitespace error；
5. capability、journal、approval 和 input 的定向测试结果；
6. 已知延期项没有被误标为完成。

### 6.2 回滚顺序

UI、windowing、notification、stream scheduler 与 journal batching 已具备独立启动时开关，也可用 `TURBOFLUX_FLOW=0` 一次回退。运行中不热切换，approval/input/capability 和 journal safety gate 不允许关闭。

建议从展示层向事实层回滚：

1. `TURBOFLUX_FLOW_WINDOWING=0`；
2. `TURBOFLUX_FLOW_NOTIFICATIONS=0`；
3. `TURBOFLUX_FLOW_STREAM_SCHEDULER=0`；
4. `TURBOFLUX_FLOW_UI=0`；
5. `TURBOFLUX_FLOW_JOURNAL_BATCHING=0`；
6. 若需同时回退上述块，使用 `TURBOFLUX_FLOW=0`；
7. approval/input lifecycle 与 capability boundary 只能通过经过评审的版本回退，不能为了兼容关闭安全边界。

回滚约束：

- 保留 v2 journal，不删除或覆盖；legacy reader 应继续忽略/读取兼容记录。
- side effect 在任一时刻只能有一个 owner；不能并行启用两套 coordinator。
- rollback 后重跑 Golden Trace、recovery、capability 和全量 build。
- 若只能紧急收敛，优先 `/capability read-only`、停止新任务并保存证据。

## 7. 仍待建设的运维能力

- 使用已提供工具采集 Windows Terminal、ConPTY、SSH、IME 的真实基线和外部物理 paint 证据；
- 在 Windows/macOS/Linux 真实桌面验证通知送达、勿扰策略与 focus reporting 支持率；
- 在发布环境执行并留存 per-block rollback drill，而不是只依赖单元测试；
- reducer violation 的版本趋势、告警阈值与响应记录；
- telemetry 时间序列、告警阈值和数据保留策略。
- 8–12 名目标开发者任务研究与完整 agent/tool 安全认证。

架构原理、风险依据和 ADR 见 [开发者心流工程蓝图](./developer-flow-engineering-blueprint.md)；本轮文件清单与验证结果见 [开发者心流实施报告](./developer-flow-implementation-report.md)。
