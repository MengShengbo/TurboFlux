# FastContext 与 Claude Code：三道陌生高难题对照

## 结论

本轮 Claude Code 3/3 命中，FastContext 2/3 命中。FastContext 在 `matplotlib__matplotlib-25332` 漏掉唯一 Gold 文件 `lib/matplotlib/cbook.py`，因此 Recall@1、Recall@10 与 MRR 均为 0.667；Claude Code 三项均为 1.000。

FastContext 继续保持较低的模型输入成本：总输入 Token 为 33,222，比 Claude Code 的 55,299 少 39.9%；API 请求为 10 次，比 Claude Code 的 14 次少 28.6%。但 FastContext 平均延迟为 75.8 秒，Claude Code 为 45.8 秒；本地工具调用为 167 次，对方为 24 次。当前版本在成本控制上有收益，但质量、常态速度和本地检索收敛仍落后。

## 实验设置

- 模型：`gpt-5.5`，两套系统均关闭原生推理。
- 权限：只读仓库检索；禁止网络、历史、Gold patch 和文件编辑。
- 任务：从真实 issue 与修复前快照中排序最多十个需要修改的实现文件。
- 样本：从 reserve 集中排除全部历史已用案例后，以 hard-random 模式抽取 3 题。
- 运行：每题每系统 1 次，单题超时 300 秒，临时错误最多重试 3 次。

## 汇总结果

| 指标 | FastContext | Claude Code |
|---|---:|---:|
| 成功运行 | 3/3 | 3/3 |
| Recall@1 / Recall@10 | 0.667 / 0.667 | 1.000 / 1.000 |
| MRR | 0.667 | 1.000 |
| 平均延迟 | 75.8s | 45.8s |
| 中位延迟 | 70.0s | 45.3s |
| 最坏延迟 | 100.4s | 56.1s |
| API 请求总数 | 10 | 14 |
| 输入 Token 总数 | 33,222 | 55,299 |
| 输出 Token 总数 | 11,320 | 3,840 |
| 工具调用总数 | 167 | 24 |
| 文件读取总数 | 46 | 24 |

## 逐题结果

| 任务 | TF R@10 | CC R@10 | TF 延迟 | CC 延迟 | TF / CC 请求 | TF / CC 输入 Token |
|---|---:|---:|---:|---:|---:|---:|
| `scikit-learn__scikit-learn-14141` | 1.000 | 1.000 | 57.0s | 36.0s | 3 / 4 | 8,174 / 8,980 |
| `matplotlib__matplotlib-25287` | 1.000 | 1.000 | 70.0s | 56.1s | 3 / 4 | 11,224 / 16,635 |
| `matplotlib__matplotlib-25332` | 0.000 | 1.000 | 100.4s | 45.3s | 4 / 6 | 13,824 / 29,684 |

FastContext 在全部三题上使用更少 API 请求和输入 Token，但没有赢下任何一道延迟对比。两道命中题说明新成本控制没有普遍破坏定位能力；第三题则暴露了尚未解决的跨证据下一跳问题。

## 漏检归因

`matplotlib__matplotlib-25332` 报告 `Figure.align_labels()` 后无法 pickle，错误为 `cannot pickle 'weakref.ReferenceType' object`。Gold 修改位于 `lib/matplotlib/cbook.py`，其中 `Grouper` 使用 `weakref.ref` 保存分组关系。

FastContext 的第一阶段正确读取了 `figure.py`，也从 `test_cbook.py` 看到 `Grouper._mapping` 含有 weakref。Adaptive 阶段随后执行了：

- `trace_symbol("_align_label_groups")`
- `trace_symbol("Grouper")`
- `trace_symbol("__getstate__")`

`trace_symbol("Grouper")` 已返回 `lib/matplotlib/cbook.py` 的定义和源码切片，但模型没有继续调用 `read_file` 确认该文件。由于最终协议只允许提交本轮 `read_file` 证实的范围，`cbook.py` 无法进入结果；模型转而把触发和持有状态的 `figure.py` 排为 owner。

Claude Code 则完整追踪了：

`Figure._align_label_groups` → `cbook.Grouper` → `Grouper._mapping` → `weakref.ref` → pickle 失败

因此将 `cbook.py` 排第一、`figure.py` 排第二、`axis.py` 排第三。

## 工程判断

这次失败不是 Planner 完全没有理解问题，也不是本地搜索没有发现 `Grouper`；真正断点发生在 **trace 已发现源码 owner，但 trace 证据与最终 read-grounded 提交协议之间缺少可靠交接**。

下一版最有价值的改进是机械化证据交接，而不是增加更多搜索：

1. 将 `trace_symbol` 返回的定义源码切片登记为可验证候选，并自动安排一次精确 `read_file(path, range)`。
2. 在 Adaptive 最后一回合前检查高信息 trace 候选是否尚未补读；若存在，则执行一个有上限的并行补读波次。
3. 保持 owner 选择由 LLM 完成，本地层只负责把模型已经选中的下一跳可靠转换为 read-confirmed 证据。

这项修复预计只增加 1–3 次廉价读取，却能消除“找到了定义但因没有补读而不能提交”的整类失败，比继续扩大词法检索或提高固定工具预算更符合 FastContext 的架构目标。

## 可信边界

- 仅 3 道题且各运行 1 次，不足以做统计显著性声明。
- 两道题来自同一 Matplotlib 仓库，不能视为三个完全独立的仓库分布。
- 本轮没有超时或 API 重试，但延迟仍会受上游服务状态影响。
- 结果足以确认一个真实失败模式，不足以估计该失败模式在完整数据集中的发生率。
