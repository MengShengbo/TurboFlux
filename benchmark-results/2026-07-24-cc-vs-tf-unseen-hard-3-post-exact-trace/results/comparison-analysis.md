# FastContext 与 Claude Code：三道陌生多文件高难题

## 结论

本轮双方平均 Recall@10 均为 0.917，均有 2/3 任务完整覆盖 Gold 文件。FastContext 平均延迟为 115.2 秒，Claude Code 为 161.4 秒；FastContext 快 28.6%，总输入 Token 少 53.8%，API 请求少 42.9%。

Claude Code 的平均 MAP 为 0.896，高于 FastContext 的 0.840。差距来自 `serverless__serverless-4192`：两套系统均找全两个 Gold，但 FastContext 将非 Gold 的 `lib/classes/cli.js` 排在第二个 Gold 之前。

这轮可以支持“FastContext 在三道陌生高难任务上达到与 Claude Code 相同的文件召回，并以更低模型成本获得更低平均延迟”；不能支持“排序质量全面超过 Claude Code”。

## 实验设置

- 数据：正式 holdout-test；reserve 集只剩 2 道历史未使用题，因此未复用旧题凑数。
- 任务：`serverless-4192`（2 Gold）、`pylint-4551`（4 Gold）、`svelte-6564`（1 Gold）。
- 模型：`gpt-5.5`，两套系统均关闭原生推理。
- 权限：只读仓库检索，不提供 Gold patch、提示、网络或 Git 历史。
- 运行：每题每系统 1 次，单题超时 300 秒，临时错误最多重试 3 次。

## 汇总结果

| 指标 | FastContext | Claude Code |
|---|---:|---:|
| 平均 Recall@10 | 0.917 | 0.917 |
| 平均 MAP | 0.840 | 0.896 |
| 完整覆盖任务 | 2/3 | 2/3 |
| 平均延迟 | 115.2s | 161.4s |
| 中位延迟 | 114.9s | 174.4s |
| 最坏延迟 | 152.4s | 210.1s |
| API 请求总数 | 12 | 21 |
| 输入 Token 总数 | 47,062 | 101,832 |
| 输出 Token 总数 | 14,708 | 5,966 |
| 工具调用总数 | 171 | 36 |
| 文件读取总数 | 44 | 36 |

FastContext 的工具调用约为 Claude Code 的 4.75 倍，但文件读取只多 22.2%。额外调用主要来自并发本地搜索，而不是模型往返；本轮 FastContext 反而在 2/3 任务上更快。因此工具调用总数不能单独作为效率结论，仍需结合墙钟时间、模型请求、Token 和召回判断。

## 逐题结果

| 任务 | TF R@10 | CC R@10 | TF MAP | CC MAP | TF 延迟 | CC 延迟 |
|---|---:|---:|---:|---:|---:|---:|
| `pylint-dev__pylint-4551` | 0.750 | 0.750 | 0.688 | 0.688 | 78.3s | 174.4s |
| `serverless__serverless-4192` | 1.000 | 1.000 | 0.833 | 1.000 | 152.4s | 99.6s |
| `sveltejs__svelte-6564` | 1.000 | 1.000 | 1.000 | 1.000 | 114.9s | 210.1s |

### Pylint

双方给出了几乎相同的排序，均命中：

1. `pylint/pyreverse/inspector.py`
2. `pylint/pyreverse/diagrams.py`
3. `pylint/pyreverse/writer.py`

双方均漏掉 `pylint/pyreverse/utils.py`。这不是 FastContext 独有退化，而是两套模型检索都没有把类型提示支持继续追踪到辅助转换层。

### Serverless

双方均找全：

- `lib/classes/pluginmanager.js`
- `lib/plugins/deploy/deploy.js`

Claude Code 将两个 Gold 排在第 1、2 位；FastContext 排在第 1、3 位，并把 `lib/classes/cli.js` 放在第 2 位。因此召回与完整覆盖持平，但 CC 的排序更精确。

FastContext 在该题触发 bounded Judge 后的 Adaptive 检索，总 Judge 阶段约 110 秒，是本轮主要尾延迟来源。

### Svelte

双方均将唯一 Gold `src/compiler/parse/state/mustache.ts` 排在第一位。FastContext 用 3 次 API 请求完成，Claude Code 使用 6 次；FastContext 延迟低 45.3%。

## 工程判断

exact trace 修复没有在陌生题上造成明显质量回退：FastContext 与 Claude Code 文件召回持平，并显著减少模型输入与请求次数。当前最值得继续优化的不是简单削减本地工具调用，而是：

1. 提高多 Gold 任务的 frontier 排序，让已读的第二实现 owner 不被编排层或调用层插队。
2. 缩短 bounded → adaptive 的最坏路径，特别是 Serverless 这种 1/4 frontier 覆盖、最终仍能找全 Gold 的任务。
3. 继续保留高信息 trace/读取，即使它增加少量本地调用；应削减的是重复、低增益搜索和过长模型输出。

## 可信边界

- 只有 3 道题、每题 1 次运行，不能做统计显著性声明。
- 任务包含 1、2、4 Gold，指标比单文件任务更严格，但样本仍不足以代表完整仓库分布。
- 公共数据可能存在模型训练污染；本实验衡量的是脚手架检索能力，而非污染隔离后的纯模型泛化。
