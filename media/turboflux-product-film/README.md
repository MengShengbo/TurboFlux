# TurboFlux Product Film

78 秒企业产品短片，使用 Remotion 以 1920×1080、30fps 确定性渲染。

## 内容

影片展示一条完整任务链：图片与目标进入输入框，FastContext 在后台检索，主 Agent 继续推进任务，用户完成范围明确的审批，Agent 修改代码并运行验证，最后展示上下文连续性与模型原生推理控制。

## 运行

```bash
npm install
npm run generate:audio
npm run start
```

```bash
npm run typecheck
npm run preview
npm run render
```

## 输出

- 母版：`out/TurboFlux-Product-Film.mp4`
- 低清预览：`out/TurboFlux-Product-Film-preview.mp4`
- 预览联系表：`render-review/v2-preview/contact-sheet.jpg`
- 母版联系表：`render-review/v2-master/contact-sheet.jpg`
- 审计：`render-review/audit.md`

`out/` 是可重复生成的渲染产物，不进入 Git。

## 结构

- `brief.md`：目标、受众、事实边界与美术方向
- `storyboard.md`：逐镜时间码、构图、转场与声音
- `narrative-graph.json`：镜头之间的因果边
- `motion-spec.json`：品牌、动效、交互锚点与音频提示
- `src/components/`：共享终端舞台与影片画布
- `src/scenes/`：八个独立镜头
- `scripts/generate-score.mjs`：原创确定性声音设计生成器
