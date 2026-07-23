# FastContext 与 Claude Code：高难度陌生题对比

## 实验口径

- 五个 case 在运行前均未出现在本地任何历史 `runs.jsonl` 中。
- 两套系统使用相同仓库快照、问题文本、`gpt-5.5`、关闭原生推理、Top-10 输出契约和 240 秒超时。
- Claude Code 仅开放只读 Glob/Grep/Read；FastContext 使用当前本地检索、条件式 ContextMaps 和闭卷证据裁决。
- 每题仅运行一次。本结果用于定位工程差距，不构成统计显著性或全面领先声明。

## 聚合结果

| 系统 | Success | R@10 | MRR | MAP | nDCG@10 | Full@10 | p50 | 平均工具调用 | 平均输入 Token |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FastContext | 100% | 0.158 | 0.250 | 0.107 | 0.178 | 0% | 80.9s | 71.8 | 10,993 |
| Claude Code | 100% | 0.569 | 0.667 | 0.417 | 0.519 | 40% | 69.3s | 12.2 | 64,023 |

Claude Code 的 R@10 高出 0.410，约为 FastContext 的 3.59 倍；MRR 高出 0.417。Claude Code 的 p50 低 14.4%，模型输入约为 FastContext 的 5.82 倍，但工具调用少 83.0%。这说明当前 FastContext 的主要问题不是预算不足，而是检索动作的信息增益偏低。

## 逐题结果

| Case | Gold | FastContext R@10 / MRR | Claude Code R@10 / MRR | FastContext read recall | Claude Code read recall | FastContext / CC 延迟 |
|---|---:|---:|---:|---:|---:|---:|
| `psf__requests-6028` | 1 | 0.000 / 0.000 | 1.000 / 0.333 | 0.000 | 1.000 | 64.0s / 61.3s |
| `sphinx-doc__sphinx-9658` | 1 | 0.000 / 0.000 | 1.000 / 1.000 | 0.000 | 1.000 | 80.9s / 76.1s |
| `coder__code-server-3277` | 11 | 0.364 / 0.250 | 0.273 / 1.000 | 0.364 | 0.273 | 90.7s / 69.3s |
| `trinodb__trino-2081` | 1 | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 | 0.000 | 103.1s / 98.5s |
| `prettier__prettier-3515` | 7 | 0.429 / 1.000 | 0.571 / 1.000 | 0.571 | 0.571 | 57.9s / 66.4s |

FastContext 的宏平均 gold read recall 为 0.187，Claude Code 为 0.569。最终 R@10 的差值为 0.410，而读取阶段已经产生 0.382 的差值。因此约九成的质量缺口形成于最终排序之前。

## 差距定位

### 1. 查询规划不是语义规划

FastContext 当前优先提取标题实体、短语、文件角色和词法变体，但仍无法可靠完成概念改写。`mocked` 没有被转换为 `mock`、`autodoc` 和 mock-import 子系统，导致 Sphinx 搜索扩散到 HTML builders；“Proxy authentication bug”也没有建立 `proxy resolution -> sessions/adapters -> utils` 的模块假设。Claude Code 会先形成子系统假设，再围绕假设读取少量文件。

### 2. 批量 shotgun 缺少反馈闭环

FastContext 在模型入场前一次性执行大量搜索、目录 census、import 探测和读取，然后要求模型在闭合集合中裁决。搜索结果无法反向更新下一轮查询。Claude Code 虽然消耗更多模型上下文和 API 请求，却能根据每次读取结果调整下一跳，因此平均 12.2 次模型定向工具调用优于 FastContext 的 71.8 次预编排调用。

### 3. 候选预算被宽泛模块耗尽

Requests 的 `utils.py` 和 Sphinx 的 `ext/autodoc/mock.py` 没进入 FastContext read ledger；正确文件不是被排错，而是根本没有资格参加最终比较。当前按来源和词法权重截断 seed 的方式，对标题短、owner 间接、仓库模块众多的任务尤其脆弱。

### 4. 变更前沿仍局限于局部目录

code-server 的真实补丁跨 `src/node`、`src/browser`、`src/common`、`lib/vscode` 和 typings。FastContext 的 feature frontier 能扩展同目录责任文件，但无法表达“服务端能力标志 -> IPC/模板 -> vendored workbench 菜单”的跨边界传播。该题 FastContext 的文件召回略高，但正确 owner 仅排第 4；Claude Code 召回略低，却把首个 gold 排第 1。

### 5. 可编辑配置文件不在主检索面

Prettier 的 gold 包含两个 ESLint YAML 配置。FastContext 的主 source glob 面向代码文件，配置、构建和元数据文件无法公平进入候选池。Claude Code 同样没覆盖全部配置文件，但找到了 `src/cli.js`，最终召回更高。

### 6. 工具契约存在健壮性缺口

Trino 中模型提交 `resolveFunction(QualifiedObjectName` 作为内容模式，引发未闭合正则错误。FastContext 随后从单次闭卷路径退化到 4 次请求恢复，但仍未读取 gold `BytecodeUtils.java`。搜索工具需要显式区分 literal 与 regex，并在非法 regex 时自动按 literal 重试；恢复流程也不应放大一次可修复的参数错误。

### 7. ContextMaps 不是本轮解法

四个正常 FastContext case 均未启用 ContextMaps；Trino 仅短暂尝试且没有改善结果。这里缺失的是问题到子系统的语义规划和反馈式检索，不是再增加一张静态关系图。CodeGraph 应继续作为 owner 已定位后的邻域扩展，而不是前置主检索器。

## 改进优先级

1. **P0：并行语义 Query Planner。** 在本地精确检索同时，让一次轻量模型调用输出实体、词形/同义变体、可能子系统、架构角色、堆栈符号和候选配置类型；两路结果合并后再读取。
2. **P0：修复搜索工具契约。** 默认提供 literal 搜索，regex 必须显式声明；非法表达式自动降级 literal，不得触发整条 Agent 恢复链。
3. **P1：条件式反馈轮。** 高置信度 owner 继续一次闭卷提交；低置信度任务允许一次模型定向搜索/读取轮，而不是无条件 closed-list 或回到多轮漫游。
4. **P1：分槽候选预算。** 为显式路径、精确符号、语义子系统、配置/构建文件、跨边界 frontier 分配独立配额，避免某一类宽泛命中吃光 seed。
5. **P1：扩展可编辑文件面。** 将 YAML、JSON、TOML、配置脚本和构建元数据纳入 edit-localization，同时保持文档与生成文件降权。
6. **P2：owner 后图扩展。** 仅围绕已验证 owner 使用 import、注册表、IPC、模板注入和调用关系构建 change frontier。
7. **P2：分阶段遥测。** 分别记录 query candidate recall、seed/read recall、owner recall 和 frontier recall，禁止只看最终 R@10 调参。

## 结论

在这组高难度完全陌生题上，Claude Code 明显领先。FastContext 的优势仍是低输入 Token、可控证据包和部分多文件召回，但当前预检索使用了更多工具、更长延迟，却没有形成足够高的信息增益。下一阶段不应继续扩大本地规则或恢复 ContextMaps 主链，而应把 LLM 放到它真正占优的语义规划和低置信度反馈位置，把本地工具保留给并发精确搜索、证据读取和确定性校验。
