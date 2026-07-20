# TurboFlux FastContext 与 Claude Code Explore 检索能力对比

> 文档性质：一次受控、单轮、工程代码检索实验。本文用于记录实验事实和改进方向，不把单轮结果包装成普遍性产品结论。

## 一、执行摘要

本实验在同一个 TurboFlux 源码工作区内，使用同一个中转 API 配置和同一个 `claude-sonnet-5` 模型，对比 TurboFlux 的 `FastContext medium` 与 Claude Code 2.1.177 的内置 `Explore` Agent。

本轮一共执行 8 个任务，每个任务两套系统各运行一次，共 16 个样本。任务同时覆盖：

- CLI 入口和中文配置文案等单点定位任务
- FastContext 调度、终端后台生命周期、模型请求兼容等跨模块调用链任务
- Transcript 滚动、剪贴板图片、Ctrl+C 中断持久化等真实开发问题

本轮最重要的结果不是“TurboFlux 在所有答案上都超过 Claude Code”，而是：

1. TurboFlux 在端到端完成率、尾延迟和本轮总体检索质量上更稳定。
2. Claude Code 在成功返回时的检索质量非常接近 TurboFlux，并且在 Ctrl+C 持久化任务上给出了更完整的文件覆盖。
3. TurboFlux 在后台终端生命周期、模型兼容性、中文精确定位任务上表现更好；Claude Code 在两个任务上达到 240 秒硬超时。
4. 目前更稳妥的产品表述是“在本轮受控实验中，TurboFlux FastContext 展现出更好的检索收敛率和延迟”，而不是直接宣称全面超过 Claude Code Explore。

## 二、实验配置

| 项目 | 配置 |
|---|---|
| 工作区 | `C:\Users\Administrator\Desktop\TurboFlux-legacy-backup-20260612-045013` |
| 实验时源码提交 | `629e4c25bc646c98113cddca4c86622a286cffdc` |
| 模型 | `claude-sonnet-5` |
| API | TurboFlux 当前活动 API 配置；两套系统使用同一中转主机和同一密钥 |
| TurboFlux | `FastContext medium`，确定性预取 + LLM 检索子代理 + 严格证据报告 |
| Claude Code | `2.1.177`，内置 `Explore` Agent |
| 权限 | 双方只读；Claude Code 使用 `--bare`、`--safe-mode`、`plan` 模式 |
| MCP、插件、记忆 | Claude Code 实验中关闭，避免本地环境污染 |
| 原生思考 | 双方关闭。该中转站可正常处理基础 Claude 请求，但会拒绝 adaptive-thinking 请求字段 |
| 单题硬超时 | 240 秒 |
| 实验轮数 | 1 轮，每题每个系统 1 次 |
| 执行顺序 | 按任务交错使用 AB/BA 顺序，降低短时间 API 波动影响 |
| 修改权限 | 禁止编辑、写入和执行破坏性操作 |

### 为什么关闭原生思考

这不是为了让某一方占便宜，而是为了让两套 CLI 使用同一可用协议基线。直接向同一 API 发送基础 `claude-sonnet-5` Anthropic Messages 请求可以成功，但带 `thinking` 或 `output_config.effort` 的请求会被该中转站重置或返回无法识别的错误，Claude Code 随后进入重试。若保留这一协议差异，测到的将主要是中转站兼容性，而不是检索系统本身。

因此本轮比较的是：

> 相同模型、相同 API、关闭原生思考时，两套代码检索编排系统能否稳定找到、读取并组织正确源码证据。

## 三、测试任务设计

### 3.1 任务分层

| 类型 | 数量 | 关注点 |
|---|---:|---|
| `location` | 2 | 是否能快速定位入口、配置文案等明确目标 |
| `workflow` | 6 | 是否能跨文件追踪执行核心、调用者、状态和持久化边界 |
| 合计 | 8 | 单点定位与真实工程调查的混合测试 |

### 3.2 参考答案的定义

每个任务预先指定一组“权威参考文件”。这些文件不是唯一可能的正确文件，而是根据当前源码人工确定的核心实现、入口、调用者或状态边界。

因此：

- 命中参考文件，说明系统覆盖了该任务的重要源码区域。
- 没命中参考文件，不必然说明整段回答完全错误，但说明它没有覆盖预先定义的关键证据。
- 额外找到的辅助文件不会被扣分。
- 参考文件质量取决于当前仓库状态，未来改动源码后需要重新审定。

## 四、指标定义

### 4.1 检索质量指标

**Recall@K**

```text
Recall@K = 前 K 个候选中命中的参考文件数 / 该任务参考文件总数
```

本轮报告同时记录 `Recall@5` 和 `Recall@10`。由于候选数量通常不超过 10，本轮两者最终相同。

**MRR（Mean Reciprocal Rank）**

```text
RR = 1 / 第一个命中参考文件的排名
MRR = 所有任务 RR 的平均值
```

MRR 更关注“系统是否很快找到了第一个真正相关文件”，不能代替完整召回率。

**Top-1 命中率**

第一个候选文件就是参考文件的任务比例。

**行号引用完整率**

候选文件是否同时给出了可定位的行号或行范围。它衡量的是报告能否直接交给开发者继续阅读，而不是只给出文件名。

**执行流完整率**

最终报告是否完成 `EXECUTION_FLOW` 结构化说明。它是格式和基本调查完整性的指标，不代表执行流中的每个判断都已经人工证明正确。

### 4.2 综合质量指数

为了避免只看一个指标，本轮使用透明的综合指数：

```text
Retrieval Quality Index
= Recall@10 × 60
+ MRR × 25
+ 行号引用完整率 × 10
+ 执行流完整率 × 5
```

所有权重都公开，不使用另一个 LLM 对回答进行主观打分。失败或超时任务的综合指数记为 `0`，因为对真实开发工作流而言，没有在预算内给出结果本身就是严重失败。

### 4.3 效率指标

- 墙钟延迟：从任务启动到进程返回的总时间。
- p50：成功样本的中位延迟。
- p95：成功样本的尾部延迟。
- Token：只统计 API 返回中能可靠获得的输入、输出和缓存 Token。
- 超时样本通常没有最终 `result.usage`，因此 Token 只能做成功样本条件统计，不能当作完整成本。

## 五、总体结果

### 5.1 端到端结果

端到端统计把超时和失败计入分母，最接近真实开发者“交给工具后能不能拿到结果”的体验。

| 指标 | TurboFlux | Claude Code | TurboFlux 变化 |
|---|---:|---:|---:|
| 完成率 | 100.0% | 75.0% | +25.0 个百分点 |
| 超时率 | 0.0% | 25.0% | -25.0 个百分点 |
| Recall@5 | 0.927 | 0.677 | +0.250 |
| Recall@10 | 0.927 | 0.677 | +0.250 |
| MRR | 1.000 | 0.750 | +0.250 |
| Top-1 命中率 | 100.0% | 75.0% | +25.0 个百分点 |
| 行号引用完整率 | 92.2% | 67.5% | +24.7 个百分点 |
| 执行流完整率 | 100.0% | 75.0% | +25.0 个百分点 |
| Retrieval Quality Index | 94.8 | 69.9 | +24.9 分 |
| 成功延迟 p50 | 66.8 秒 | 107.0 秒 | 低 37.6% |
| 成功延迟 p95 | 107.0 秒 | 208.7 秒 | 低 48.7% |

### 5.2 只看成功返回样本

这个视角用于回答另一个问题：当 Claude Code 没有超时并且确实返回了报告时，它的内容质量如何？

| 指标 | TurboFlux | Claude Code | 结论 |
|---|---:|---:|---|
| 成功样本数 | 8 | 6 | TurboFlux 多完成 2 题 |
| Recall@10 | 0.927 | 0.903 | 两者接近，TurboFlux 略高 |
| MRR | 1.000 | 1.000 | 首个相关文件定位均很强 |
| 行号引用完整率 | 92.2% | 90.0% | 两者接近 |
| Retrieval Quality Index | 94.8 | 93.2 | 成功样本质量基本同一水平 |
| 平均输入 Token | 1,310 | 949 | Claude Code 输入更短 |
| 平均输出 Token | 1,645 | 2,429 | Claude Code 输出更长 |
| 平均缓存读取 Token | 12,330 | 14,122 | Claude Code 缓存读取更多 |

### 5.3 结果如何解释

如果只看“成功返回的回答内容”，TurboFlux 并没有形成压倒性优势；`94.8 vs 93.2` 说明两者在成功状态下都能完成较高质量的代码定位。

真正拉开差距的是端到端可靠性：Claude Code 的两个超时任务分别是 FastContext 调度链和中文配置文案定位。对于开发者而言，一次 240 秒没有最终报告的任务会显著降低实际可用性，因此端到端指标不能被成功样本指标取代。

## 六、逐题结果与工程解读

| 任务 | TurboFlux | Claude Code | 更强的一方 | 关键观察 |
|---|---|---|---|---|
| CLI 入口 | 63.2s，1.00 | 49.1s，1.00 | Claude Code 速度 | 两者都找到 `bin`、Commander 入口和 `repl` 交接层；Claude Code 快约 14.1 秒 |
| FastContext 调度 | 80.5s，0.67 | 240.1s，超时 | TurboFlux 端到端 | TurboFlux 找到子代理实现和引擎，但漏掉 `subAgent.ts`；Claude Code 未在预算内完成 |
| Transcript 滚动 | 73.5s，1.00 | 113.4s，1.00 | TurboFlux 速度 | 两者都覆盖 App、Viewport、terminalMouse；TurboFlux 快约 35.2% |
| 中文 setup 文案 | 65.1s，1.00 | 240.0s，超时 | TurboFlux | TurboFlux 直接命中 `src/cli/setup.ts`；Claude Code 未收敛 |
| 剪贴板图片 | 60.9s，1.00 | 107.0s，1.00 | TurboFlux 速度 | 两者都找到图片采集、App UI 和 contextManager 转换链 |
| 后台终端生命周期 | 95.8s，1.00 | 208.7s，0.67 | TurboFlux | TurboFlux 覆盖三组参考文件；Claude Code 漏掉 `shared/terminalTypes.ts` 且耗时更高 |
| 模型请求兼容 | 66.8s，1.00 | 91.3s，0.75 | TurboFlux | TurboFlux 找到四个关键协议/请求模块；Claude Code 漏掉 `agentEngine.ts` |
| Ctrl+C 持久化 | 107.0s，0.75 | 122.9s，1.00 | Claude Code 召回 | Claude Code 覆盖 manager/store/engine/App 四层；TurboFlux 漏掉 `conversations/manager.ts` |

### 6.1 TurboFlux 的优势样本

**后台终端生命周期**是本轮最有价值的正向样本。TurboFlux 的报告覆盖了：

```text
AgentEngine 调度
→ NodeToolExecutor 执行核心
→ terminalTypes 状态契约
→ executor / App / AgentRuntime 辅助边界
```

Claude Code 也找到了执行核心，但没有在前十候选中覆盖 `src/shared/terminalTypes.ts`，并且耗时达到 `208.7` 秒。

**模型请求兼容性**体现了 TurboFlux 对自身架构的可检索性。TurboFlux 一次覆盖了：

```text
agentEngine.ts
modelRegistry.ts
modelProtocol.ts
subAgent.ts
```

这正好对应请求构造、模型能力判断、协议选择、子代理请求循环四个层次。

### 6.2 TurboFlux 的弱项样本

**FastContext 调度任务**中，TurboFlux 虽然首个命中是正确的 `fastContextSubagent.ts`，也找到 `agentEngine.ts`，但没有把 `subAgent.ts` 排进前十。对于“主代理如何启动子代理、子代理如何执行模型循环”的问题，`subAgent.ts` 是不能遗漏的关键文件。

**Ctrl+C 持久化任务**中，TurboFlux 找到了 `App.tsx`、`store.ts`、`types.ts` 和 `agentEngine.ts`，但漏掉了 `conversations/manager.ts`。这会让报告更偏向“状态恢复”和“数据结构”，而没有完整覆盖“每个流事件如何被写入 journal”的中间持久化层。

### 6.3 Claude Code 的优势样本

Claude Code 在 **Ctrl+C 持久化**任务上给出了本轮最完整的调用链，覆盖：

```text
App.tsx 输入与 SIGINT
→ AgentEngine.abort / finishInterruptedStream
→ conversations/manager.ts journal 写入
→ conversations/store.ts 恢复
→ Messages.tsx 渲染 Interrupted 状态
```

这说明 Claude Code 在成功收敛后，能够通过更长的探索过程补足 UI、引擎、持久化和渲染多个层次。

## 七、效率和 Token 观察

### 7.1 延迟

TurboFlux 成功样本 p50 为 `66.8` 秒，Claude Code 为 `107.0` 秒；TurboFlux 低 `40.2` 秒。p95 方面，TurboFlux 为 `107.0` 秒，Claude Code 为 `208.7` 秒，低 `101.7` 秒。

这与两套系统的工作方式有关：

- TurboFlux 先做确定性预取，再把紧凑证据包交给 FastContext 子代理。
- Claude Code 的 Explore 过程更倾向于反复搜索、读取和补充确认，成功时可能得到更完整的上下文，但尾延迟更高。

### 7.2 Token

成功样本的平均 Token 如下：

| 项目 | TurboFlux | Claude Code | 观察 |
|---|---:|---:|---|
| 输入 Token | 1,310 | 949 | Claude Code 平均输入更少 |
| 输出 Token | 1,645 | 2,429 | Claude Code 平均报告更长 |
| 缓存创建 Token | 866 | 482 | 两者受缓存策略和请求前缀影响不同 |
| 缓存读取 Token | 12,330 | 14,122 | Claude Code 读取缓存更多 |

超时样本没有可靠的最终 usage 汇总，因此不能用这组数字比较完整总成本。Claude Code 的原始成功样本报告了代理侧成本，但 TurboFlux 使用同一自定义中转站，未返回可直接比较的成本字段，本文不进行伪精确美元换算。

## 八、目前能对外说什么

### 可以说

- “在当前 8 题单轮受控实验中，TurboFlux FastContext 的端到端完成率为 100%，Claude Code Explore 为 75%。”
- “在相同模型和 API 基线下，TurboFlux 本轮成功样本的 p50/p95 延迟低于 Claude Code。”
- “成功返回时，两者的代码覆盖质量接近；TurboFlux 的主要优势体现在收敛稳定性、尾延迟和预取后证据组织。”
- “TurboFlux 对后台终端生命周期、模型请求兼容等自身工程链路表现出较强的定位能力。”

### 暂时不要说

- “TurboFlux 在所有检索任务上全面超过 Claude Code。”
- “TurboFlux 的 Recall 永远高于 Claude Code。”
- “这 8 道题已经证明了统计学意义上的绝对领先。”
- “TurboFlux 的 Token 或成本一定低于 Claude Code。”

## 九、实验局限

1. 只有一轮，每题一次，无法估计随机输出和网络波动下的置信区间。
2. 8 个任务来自当前 TurboFlux 真实开发痛点，不能代表所有语言、框架和陌生仓库。
3. 参考文件集合是人工定义的核心文件集合，不是完整的形式化程序真值集。
4. 关闭了原生思考，结论主要反映检索编排和工具使用能力，不是最大 reasoning 档位对比。
5. Claude Code 使用内置 Explore Agent；没有比较其完整默认工作流、插件、MCP 或用户记忆生态。
6. 超时样本没有最终 Token 汇总，Token 数据只能做成功样本条件分析。
7. 端点是自定义中转站，协议兼容性会影响真实延迟和重试行为；官方 Anthropic API 上应单独复测。

## 十、下一版正式基准建议

### 10.1 轮数和统计

- 每个任务至少运行 5 轮，总样本扩大到 40 个以上。
- 固定一组冷缓存轮和一组热缓存轮，分别统计。
- 报告均值、中位数、p95、标准差和 bootstrap 置信区间。
- 对超时、协议失败、工具错误、低质量完成分别分类，不能全部归入一个失败桶。

### 10.2 任务集扩展

- 增加陌生开源仓库，不只测试 TurboFlux 自身源码。
- 增加 Python、Rust、Go、Java、React、Node 等多语言任务。
- 增加“同名多实现”“错误日志反查”“配置到运行时”“测试到实现”“跨包调用链”等任务。
- 增加刻意误导的文档、测试、index barrel 和旧实现，测试反证搜索能力。
- 增加用户真实问题的盲测，由第三方工程师标注权威路径和可接受替代路径。

### 10.3 TurboFlux 重点改进

1. FastContext 调度题必须提高 `subAgent.ts`、`agentEngine.ts`、`fastContextSubagent.ts` 三者的共同召回率。
2. Ctrl+C 持久化题需要强化 `conversations/manager.ts` 这一事件写入层的召回。
3. 在 max 档位中加入“关键层级覆盖检查”：若只有 UI 和实现，没有状态/持久化/调用者，应继续检索。
4. 将“已读取文件”与“搜索命中文件”在最终报告中分离，避免把 grep 看到的文件写成已经读透。
5. 继续优化 deterministic prefetch 与 LLM 读取预算的分工，避免 medium 档位在简单任务上读取过多。

### 10.4 Claude Code 对比建议

下一轮应在官方 API 或确认兼容 adaptive thinking 的端点上，追加一组双方都开启原生 reasoning 的实验。否则本报告只能评价“同模型、无原生思考时的检索编排”，不能评价两套产品在最大推理档位下的完整能力。

## 十一、可复现入口

运行完整实验：

```powershell
npm run benchmark:retrieval-competitive
```

基于已有原始结果重新计算 Markdown 和结构化指标：

```powershell
npm run benchmark:retrieval-competitive -- --rescore
```

相关文件：

- `scripts/competitive-retrieval-benchmark.ts`：实验驱动、任务、评分和报告生成器
- `comparison-data.json`：清洗后的正式结构化数据
- `raw-results.json`：包含每次模型报告的完整原始结果
- `report.md`：简版结果摘要

## 十二、结论

这轮实验支持一个有价值但边界清晰的判断：

> TurboFlux FastContext 当前已经具备工程级代码检索竞争力。在相同模型和 API、关闭原生思考的条件下，它在本轮任务上表现出更高的端到端完成率、更低的尾延迟和更稳定的证据报告；但在成功返回的内容质量上，Claude Code Explore 仍然非常接近，并且在部分完整调用链任务上更强。

下一步真正值得做的不是继续用一句“超过 Claude Code”包装结果，而是扩大任务集、增加轮数、建立第三方标注和置信区间，然后把 TurboFlux 的优势从“本轮实验优势”推进成可重复的工程指标优势。
