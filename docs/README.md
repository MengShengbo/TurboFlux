# TurboFlux 工程文档

这里是 TurboFlux TUI 工程文档的唯一入口。TurboFlux 的产品主体是本地 Ink 终端界面；文档分为“当前实现规范”和“研究/演进资料”两类：前者必须随代码更新，后者用于保留决策背景，不代表当前行为。

## 快速入口

| 读者 | 建议起点 | 目标 |
| --- | --- | --- |
| 新贡献者 | [本地开发](guides/development.md) | 在 15 分钟内完成安装、测试和首次修改 |
| 维护者 | [系统总览](architecture/system-overview.md) | 理解进程、模块边界和请求主链路 |
| Runtime 开发者 | [运行生命周期](architecture/runtime-lifecycle.md) | 理解 Agent、工具、审批、后台任务和恢复 |
| TUI 开发者 | [模块地图](reference/module-map.md) | 找到 CLI 状态、组件、事件和持久化责任人 |
| 发布负责人 | [发布手册](operations/release.md) | 完成版本一致性、质量门禁和发布验证 |
| 故障处理者 | [排障手册](operations/troubleshooting.md) | 从症状定位配置、会话、MCP、TUI 或代理服务问题 |

## 当前实现规范

### 架构

- [系统总览](architecture/system-overview.md)：系统上下文、分层边界、核心数据流与扩展点。
- [运行生命周期](architecture/runtime-lifecycle.md)：一次 TUI 交互从按键到持久化的完整状态机。
- [安全模型](architecture/security-model.md)：能力边界、审批、密钥、路径与服务暴露约束。
- [TUI 源码深读审计](tui-source-audit.md)：逐模块事实、状态所有权和当前工程债务。

### 开发与质量

- [工程化文档方案](engineering/documentation-plan.md)：文档地图、维护规则、阶段计划和完成标准。
- [贡献指南](../CONTRIBUTING.md)：分支、提交、变更步骤和评审清单。
- [本地开发](guides/development.md)：环境、命令、常见扩展流程。
- [测试策略](guides/testing.md)：测试分层、专项门禁、性能与终端矩阵。

### 参考与运维

- [模块地图](reference/module-map.md)：源码目录、公共入口和测试责任映射。
- [配置参考](reference/configuration.md)：CLI 参数、配置文件、环境变量和本地数据。
- [发布手册](operations/release.md)：版本更新、打包、验证和回滚。
- [排障手册](operations/troubleshooting.md)：健康检查、诊断顺序和数据恢复。
- [ADR 索引](adr/README.md)：重要架构决策及新增模板。

## 研究与演进资料

下列文档保留早期实现背景、审计证据或阶段性路线，不作为当前 TUI API/行为承诺；当前事实以架构、指南和参考文档为准：

- [开发者心流工程蓝图](developer-flow-engineering-blueprint.md)
- [开发者心流实施报告](developer-flow-implementation-report.md)
- [开发者心流运维手册](developer-flow-operations-runbook.md)
- [Runtime 差距与路线](runtime-gap-roadmap.md)
- [源码结构审计](source-architecture-audit.md)
- [模型协议兼容性](model-protocol-compatibility.md)
- [Codex 桌面端逆向审计](codex-desktop-reverse-engineering.md)

## 文档约定

- 当前事实优先引用源码路径、类型名、命令和数据文件，不复制易漂移的大段实现。
- Mermaid 图只表达稳定边界；细粒度调用关系以源码和测试为准。
- 配置项、持久化格式、公开命令、质量门禁或模块责任变化时，同一 PR 更新对应文档。
- 新增跨模块约束前先写 ADR；小型局部实现无需 ADR。
- 文档链接使用仓库相对路径，命令从仓库根目录执行。

文档治理和覆盖矩阵见[工程化文档方案](engineering/documentation-plan.md)。
