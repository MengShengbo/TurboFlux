# 贡献指南

感谢参与 TurboFlux。工程文档入口位于 [`docs/README.md`](docs/README.md)，系统边界先从[系统总览](docs/architecture/system-overview.md)阅读。

## 开发环境

- Node.js 20 或更高版本。
- 使用 `npm ci` 按锁文件安装依赖。
- Windows、macOS 和 Linux 都是 CI 支持平台。

```bash
npm ci
npm run type-check
npm test
npm run build
```

## 变更流程

1. 从最新主分支创建主题分支。
2. 先定位状态所有者和已有测试，再修改实现。
3. 为行为变化补充相邻单元测试；跨层 Flow 行为同时补专项测试。
4. 运行最小相关测试，再运行完整质量门禁。
5. 更新受影响的配置、架构、运维或参考文档。
6. 提交聚焦且可独立回滚的变更。

## 质量门禁

日常变更至少运行：

```bash
npm run type-check
npm test
npm run build
```

触及 TUI Flow、会话恢复、审批、后台任务或终端兼容时运行：

```bash
npm run ci:flow
```

`ci:flow` 依次执行类型检查、完整测试、Flow 性能检查、TUI smoke 和构建。详细测试分层见[测试策略](docs/guides/testing.md)。

## 设计规则

- `src/shared/` 只放跨层契约，不依赖 CLI 或 Node 实现。
- `src/core/` 不直接拥有 Ink 渲染状态；UI 通过事件和运行时接口消费核心能力。
- 新后台工作接入 `RuntimeTaskManager`，新会话身份变化接入 `SessionRegistry`。
- 新文件系统或命令能力通过 `CapabilityBoundary`、工具元数据和审批链路表达。
- 新持久化格式必须带版本、容忍尾部损坏，并提供迁移或兼容读取策略。
- 新用户可见文本进入 i18n 消息表；新命令进入命令注册表。

## 文档与 ADR

变更公开参数、环境变量、数据路径、模块责任、CI 或发布流程时，同一变更更新对应文档。引入跨模块且长期有效的约束时，从 [`docs/adr/0000-template.md`](docs/adr/0000-template.md)复制一份 ADR。

## 提交建议

使用清晰的意图前缀，例如 `feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`chore:`。提交正文说明关键约束、验证命令和兼容性影响，不提交本地凭据、会话日志、遥测或生成产物。

## 评审清单

- 行为和错误路径有测试覆盖。
- 写入、命令、网络和后台任务遵守能力与审批边界。
- 事件、日志和配置 schema 的兼容性已处理。
- 没有把密钥或用户内容写入遥测、日志或测试夹具。
- 文档和版本来源保持同步。
