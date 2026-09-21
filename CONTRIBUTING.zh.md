# 贡献指南

[English](CONTRIBUTING.md) | 中文

TurboFlux 目前由仓库所有者维护，暂不接受外部 Pull Request，仓库规则会自动关闭外部 PR。请通过 [Issues](https://github.com/MengShengbo/TurboFlux/issues) 提交可复现的问题、功能需求、研究和反馈。也欢迎在自己的仓库创建插件、Skills、集成与 Work Pack。

## 源码与分支

本仓库发布 Desktop 及其依赖的领域包和远控客户端；Orbit 不属于本次源码发布范围。远端只长期保留 `main`。维护者用于验证的临时分支在集成后删除。依赖升级由维护者处理，已关闭自动版本更新 PR。

## 维护者检查

准备 Node.js 22.12 或更新版本、npm 和 ripgrep，在仓库根目录执行：

```sh
npm ci
npm run ci
```

本地检查覆盖 lint、领域包与应用构建、所有 workspace 类型检查、领域包测试、Desktop 测试、远控测试，以及发布和架构边界。Lefthook 在提交前执行暂存文件 lint 和空白检查，在推送前执行源码检查。如果安装依赖时跳过了生命周期脚本，可运行 `npx lefthook install` 确认钩子已安装。

GitHub Actions 还会验证 Linux、Windows 的领域包测试，macOS、Windows 的 Desktop 测试，以及 macOS、Windows、Linux 的打包与验收证据。必需的 **Quality gate** 只有在所有依赖任务成功后才会通过。`main` 的保护规则同样约束管理员，并禁止强制推送与删除。更新 `main` 前，维护者先将候选提交推送到临时 `codex/desktop-source-*` 分支。推送会自动触发分支保护所需的 CI；通过后再推进 `main`，并删除临时分支。

外部 PR 规则使用受信任的默认分支工作流，具备关闭来自 fork 的 PR 所需权限，不检出或执行 PR 中的代码。Issue 分类失败会明确报错，不再静默忽略。

请勿提交凭据、本地资料、生成的验收证据、构建产物和研究归档。各平台签名与分发仍需单独验证。
