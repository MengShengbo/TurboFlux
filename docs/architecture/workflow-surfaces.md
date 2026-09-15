# Workflow Surface extension contract

深度插件不应把多阶段工作做成一串聊天确认，也不应为每个插件修改 Agent 核心或 Desktop renderer。TurboFlux 提供通用的可暂停、可恢复 Workflow Surface 基座，插件只负责声明阶段和内容。

## Plugin responsibilities

插件贡献者只需要：

1. 在 manifest 的 `contributes.workflows` 声明稳定的 workflow `id`、阶段列表，以及需要宿主自动暂停的 checkpoint trigger；renderer 只属于具体 checkpoint 或动态 `present_workflow` 调用。
2. 在 Skill 中描述状态机、研究边界、子 Agent 协作契约和完成标准。
3. 在 Agent 回合中调用 `present_workflow`，传入当前阶段的标题、问题、choices、directions 或 input。
4. 将研究报告、索引和截图写入工作区受控目录，并在 Surface 中只传路径、摘要和候选标签。

插件不得修改 `AgentEngine`、`ApprovalCoordinator`、Workbench IPC 或 renderer。插件特有的视觉差异应通过 `WorkflowSurfaceSpec` 的数据表达；真正需要独特布局时才申请新的通用 renderer，而不是添加插件名称分支。

## Host guarantees

宿主负责：

- 将 `present_workflow` 转换为输入 checkpoint，并暂停当前对话而不阻塞其他 conversation runtime；
- 在声明的工具成功完成后自动打开 checkpoint，并可在 trigger 完成前阻断插件声明的越阶段工具；
- 持久化 request、传递 `options`、`reason` 和 `ui` 元数据，重连或恢复后重新显示 Surface；
- 统一处理键盘焦点、动画、窄屏、暗色和 `prefers-reduced-motion`；
- 只从工作区的 `.turboflux/workflows/`、兼容的 `.turboflux/design-atlas/` 或附件存储加载截图，拒绝越界路径；
- 在用户选择后恢复 Agent，不把截图二进制、长报告或子 Agent transcript 注入主对话。

## Surface stages

`stage` 是插件定义的稳定字符串，宿主不依赖插件名称猜测行为。优先声明 `renderer`：

- `choice`：少量决策卡；
- `count`：带合法范围的数字输入；
- `gallery`：截图方向卡和编号选择；

当前稳定协议只接受以上三种 renderer。插件不得声明 `custom`；未来若开放扩展 renderer，必须先提供宿主注册表、版本协商和降级行为，再扩展 manifest schema。

`stage` 用于恢复和分析，不应携带临时文案。一次 Surface 只代表一个人类 checkpoint；不要在同一回合同时创建多个交互 Surface。

需要不可绕过的阶段边界时，在 `checkpoints[]` 声明 `trigger.tool` 与可选的参数匹配条件。宿主只在对应工具成功后弹出 Surface，并把选择写回隐藏 workflow context；`blockBeforeTrigger` 可阻止模型在准备产物完成前创建后续任务。插件仍可为动态画廊调用 `present_workflow`，但不应依赖提示词记住固定数量、审批或配置 checkpoint。

同一产物可能由多个等价工具完成时使用 `trigger.tools`，例如文件首次创建使用 `write_file`，恢复流程改写已有文件使用 `replace_file`。`trigger.tool` 保留用于单工具声明；宿主对两种写法一视同仁，插件不应为了工具别名修改 Agent 核心。

## Research isolation

深度研究应由插件 Skill 决定是否启动，并行子 Agent 只返回报告路径、索引路径、短摘要和候选 ID。主 Agent 等待所有任务进入终态后，按索引选择性读取报告和截图；每批最多将三张参考图交给多模态上下文。失败的子 Agent 可以部分降级，但不能伪造报告或把完整 transcript 灌入主对话。

## Design Atlas example

设计图谱声明 `research-gate`、`direction-count` 和 `direction-gallery` 三个阶段。它的 Skill 负责深度调研、基础规范、1–20 抽卡、真实截图验收和编号选型；宿主只负责显示 Surface 和恢复请求。这种分工使其他研究型、审批型或预览型插件可以复用同一基座而不触碰核心。
