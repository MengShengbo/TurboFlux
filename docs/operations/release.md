# 发布手册

## 当前发布形态

TurboFlux 当前主要通过 GitHub 仓库全局安装，`package.json` 暴露 `turboflux` bin，TypeScript 编译产物位于 `dist/`。GitHub Actions 负责三平台质量门禁，仓库暂未定义自动发版 workflow。

## 发布前检查

```bash
git status --short --branch
git pull --ff-only
npm ci
npm run ci:flow
npm pack --dry-run
```

成功判据：

- 工作树只包含本次发布变更。
- 分支已与远端同步。
- Node.js 20 下完整门禁通过。
- `npm pack --dry-run` 清单包含 `bin/`、`dist/`、`package.json`、许可证和必要文档，不包含凭据、会话、遥测、临时目录或宣传视频大产物。

## 版本一致性

当前版本并非单一来源，发布时必须同步检查：

| 文件 | 位置 |
| --- | --- |
| `package.json` | 包版本 |
| `package-lock.json` | 根包版本 |
| `src/cli/index.ts` | Commander `version()` |
| `src/cli/brand.ts` | `TURBOFLUX_VERSION` |
| `src/cli/setup.ts` | Setup 标题版本 |
| `src/core/mcp/client.ts` | MCP client 版本 |
| `src/core/clientIdentity.ts` | 包版本读取与 fallback |

建议先用 npm 更新包与锁文件，再同步源码常量：

```bash
npm version <patch|minor|major> --no-git-tag-version
```

之后执行：

```bash
rg -n "0\.1\.5|version\(" package.json package-lock.json src
npm run type-check
npm test
```

长期改进是让 CLI、Setup、MCP 和 Client Identity 全部读取 `package.json` 或构建期生成的单一版本模块。

## 发布步骤

1. 明确语义版本和用户可见变更。
2. 更新所有版本来源。
3. 更新 README、工程文档和变更说明。
4. 运行 `npm ci` 与 `npm run ci:flow`。
5. 运行 `npm pack --dry-run` 并检查文件清单。
6. 本地安装 tarball，验证 `turboflux --version`、`turboflux setup show` 和一次 single-shot。
7. 提交发布变更并推送分支，等待远端三平台门禁通过。
8. 合并到 `main` 后创建带注释 tag `v<version>` 并推送。
9. 验证 GitHub 安装脚本和全局安装路径。
10. 只有在明确启用 npm registry 发布渠道时执行 registry publish。

本地 tarball 验证示例：

```bash
npm pack
npm install -g ./turboflux-<version>.tgz
turboflux --version
```

## 发布验证

至少验证：

- `turboflux --version` 与 tag/包版本一致。
- `turboflux setup show` 不显示完整密钥。
- `turboflux . --command "列出当前目录"` 能完成一次模型与工具循环。
- `/help`、`/model`、`/approval`、`/capability`、`/resume` 可用。
- 会话退出后可恢复，后台任务能收敛到终态。
- Windows、macOS 和 Linux 的 CI 均通过。

## 回滚

发布后出现问题时：

1. 保留失败版本 tag 和构建日志，记录影响范围。
2. 从上一个正常 tag 安装并验证核心路径。
3. 在新提交中修复问题，不重写已经公开的主分支或 tag。
4. 发布新的 patch 版本并在说明中标注修复范围。

数据格式问题优先提供兼容读取或迁移；不要要求用户直接删除会话、记忆或配置。恢复步骤见[排障手册](troubleshooting.md)。

## 发布自动化路线

1. 增加版本一致性检查脚本。
2. 增加 package contents allowlist。
3. 生成 changelog 和 SBOM/依赖清单。
4. 在 tag workflow 中复跑三平台门禁并生成 tarball/hash。
5. 为安装脚本增加固定 tag 与校验和支持。
