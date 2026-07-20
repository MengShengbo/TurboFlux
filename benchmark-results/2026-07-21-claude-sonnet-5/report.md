# TurboFlux FastContext 与 Claude Code Explore 对比

> 正式详细对比资料见 `comparison-report.md`；机器可读数据见 `comparison-data.json`。本文件为快速摘要。

**日期**: 2026-07-20T18:06:14.078Z  
**工作区提交**: `629e4c25bc646c98113cddca4c86622a286cffdc`  
**模型/API**: 通过同一配置的 Anthropic 端点使用 claude-sonnet-5  
**检索模式**: TurboFlux 中等模式；Claude Code 内置 Explore Agent  
**推理**: 两者均禁用（因本中继拒绝自适应思维请求字段）  
**单用例超时**: 240秒；每个用例运行一次  
**顺序**: 按用例交替 AB/BA 执行，以减少时间窗口偏差

---

## 汇总数据

| 指标 | TurboFlux | Claude Code |
|------|-----------|-------------|
| 成功率 | 100.0% | 75.0% |
| 超时率 | 0.0% | 25.0% |
| Recall@5 | 0.927 | 0.677 |
| Recall@10 | 0.927 | 0.677 |
| MRR | 1.000 | 0.750 |
| Top-1 命中率 | 100.0% | 75.0% |
| 行引用率 | 92.2% | 67.5% |
| 执行流章节完成率 | 100.0% | 75.0% |
| **检索质量指数** | **94.8** | **69.9** |
| 仅成功用例 Recall@10 | 0.927 | 0.903 |
| 仅成功用例 MRR | 1.000 | 1.000 |
| 仅成功用例引用率 | 92.2% | 90.0% |
| 仅成功用例质量指数 | 94.8 | 93.2 |
| 成功用例延迟 p50 | 66.8秒 | 107.0秒 |
| 成功用例延迟 p95 | 107.0秒 | 208.7秒 |
| 平均 API 重试次数 | 0.0 | 0.0 |
| 平均成功输入/输出 Token | 1310 / 1645 | 949 / 2429 |
| 平均成功缓存创建/读取 | 866 / 12330 | 482 / 14122 |

> **检索质量指数**为透明计算（非模型评判）：Recall@10 占 60%，倒数排名占 25%，行引用完整性占 10%，执行流契约完成度占 5%。失败或超时用例计 0 分。Claude Code 超时运行未输出最终用量数据，因此 Token 对比仅使用成功用例，不应解读为总开销。

---

## 观察结果

- **TurboFlux** 完成 8/8 任务；**Claude Code** 完成 6/8
- **TurboFlux** 成功延迟 p50 低 37.6%，p95 低 48.7%
- 端到端质量 **TurboFlux 占优（94.8 vs 69.9）**，主要因 Claude Code 两次超时
- 仅看成功用例时，质量接近（94.8 vs 93.2）；主要优势体现在**收敛可靠性和延迟**，而非通用答案优越性
- **TurboFlux** 在其自身 FastContext 调度追踪中遗漏了一个引用文件，在中断流追踪中也遗漏了一个。Claude Code 在中断流映射方面更完整，而 TurboFlux 在后端终端生命周期方面更强，并完成了 Claude Code 超时的中文精确复制任务

---

## 各用例详情

| 用例 | 系统 | 成功 | Recall@10 | MRR | 质量 | 延迟 | 重试 | 输入/输出 Token |
|------|------|------|-----------|-----|------|------|------|----------------|
| cli-entry | turboflux | ✅ | 1.00 | 1.00 | 100.0 | 63.2s | 0 | 1259/1170 |
| cli-entry | claude-code | ✅ | 1.00 | 1.00 | 100.0 | 49.1s | 0 | 570/1400 |
| fast-context-scheduling | turboflux | ✅ | 0.67 | 1.00 | 73.8 | 80.5s | 0 | 1309/1604 |
| fast-context-scheduling | claude-code | ❌ | 0.00 | 0.00 | 0.0 | 240.1s | 0 | 0/0 |
| transcript-scroll | turboflux | ✅ | 1.00 | 1.00 | 100.0 | 73.5s | 0 | 1283/1842 |
| transcript-scroll | claude-code | ✅ | 1.00 | 1.00 | 96.0 | 113.4s | 0 | 515/1975 |
| chinese-setup-copy | turboflux | ✅ | 1.00 | 1.00 | 100.0 | 65.1s | 0 | 1399/1270 |
| chinese-setup-copy | claude-code | ❌ | 0.00 | 0.00 | 0.0 | 240.0s | 0 | 0/0 |
| clipboard-images | turboflux | ✅ | 1.00 | 1.00 | 100.0 | 60.9s | 0 | 1332/1530 |
| clipboard-images | claude-code | ✅ | 1.00 | 1.00 | 100.0 | 107.0s | 0 | 857/2286 |
| background-terminal-lifecycle | turboflux | ✅ | 1.00 | 1.00 | 100.0 | 95.8s | 0 | 1305/1756 |
| background-terminal-lifecycle | claude-code | ✅ | 0.67 | 1.00 | 78.0 | 208.7s | 0 | 1580/3406 |
| model-request-compatibility | turboflux | ✅ | 1.00 | 1.00 | 100.0 | 66.8s | 0 | 1292/1691 |
| model-request-compatibility | claude-code | ✅ | 0.75 | 1.00 | 85.0 | 91.3s | 0 | 957/2381 |
| interrupted-stream-persistence | turboflux | ✅ | 0.75 | 1.00 | 85.0 | 107.0s | 0 | 1301/2294 |
| interrupted-stream-persistence | claude-code | ✅ | 1.00 | 1.00 | 100.0 | 122.9s | 0 | 1212/3127 |

---

## 失败记录

- **claude-code / fast-context-scheduling**: 240000ms 后超时
- **claude-code / chinese-setup-copy**: 240000ms 后超时

---

## 解读限制

- 此为单轮测试，延迟波动和随机输出差异尚未建立置信区间
- 真实基准覆盖已知权威文件；额外的有效支持文件不扣分
- 自定义中继要求禁用推理功能。这隔离了检索编排能力的对比，但**不比较原生推理质量的上限**
- Claude Code 运行在裸/安全、只读 Explore 模式下；排除了用户插件、MCP 服务器、记忆功能和项目指令
