export type BrowserToolActivityStatus = 'running' | 'completed' | 'failed'

export interface BrowserToolActivityPresentation {
  title: string
  detail: string
  needsApproval: boolean
}

export interface BrowserPermissionPresentation {
  title: string
  question: string
  reason: string
  runningDetail: string
}

interface BrowserToolDefinition {
  title: string
  running: string
  completed: string
  needsApproval: boolean
  permissionAction?: string
  permissionReason?: string
}

const BROWSER_TOOL_PREFIX = 'browser__'

const BROWSER_TOOLS: Record<string, BrowserToolDefinition> = {
  open: { title: '打开网页', running: '正在打开网页', completed: '网页已打开', needsApproval: false },
  tabs: { title: '查看网页', running: '正在检查打开的网页', completed: '已检查打开的网页', needsApproval: false },
  activate: { title: '切换浏览标签', running: '正在切换到目标网页', completed: '已切换到目标网页', needsApproval: false },
  navigate: { title: '前往页面', running: '正在前往页面', completed: '页面已打开', needsApproval: false },
  observe: { title: '阅读页面', running: '正在读取当前页面', completed: '已读取当前页面', needsApproval: false },
  find: { title: '查找页面控件', running: '正在查找可操作内容', completed: '已找到可操作内容', needsApproval: false },
  visual_observe: { title: '查看页面画面', running: '正在查看当前画面', completed: '已查看当前画面', needsApproval: false },
  click: { title: '点击网页内容', running: '正在真实点击页面内容', completed: '已完成网页点击', needsApproval: true, permissionAction: '点击当前网页中的内容' },
  type: { title: '填写网页', running: '正在填写页面内容', completed: '已填写页面内容', needsApproval: true, permissionAction: '在当前网页填写内容', permissionReason: '这会把内容填写到当前网页，可能向网站发送信息。' },
  press: { title: '操作网页', running: '正在使用键盘操作页面', completed: '已完成键盘操作', needsApproval: true, permissionAction: '在当前网页执行键盘操作' },
  select_option: { title: '选择网页选项', running: '正在选择页面选项', completed: '已更新页面选项', needsApproval: true, permissionAction: '更改当前网页中的选项' },
  set_checked: { title: '更新网页选项', running: '正在更新页面选项', completed: '已更新页面选项', needsApproval: true, permissionAction: '更改当前网页中的勾选状态' },
  upload_file: { title: '上传文件', running: '正在把文件添加到网页', completed: '文件已添加到网页', needsApproval: true, permissionAction: '把工作区文件添加到当前网页', permissionReason: '这会将所选本地文件共享给当前网站。' },
  hover: { title: '查看页面内容', running: '正在查看悬停内容', completed: '已查看悬停内容', needsApproval: false },
  click_at: { title: '操作页面画面', running: '正在操作当前画面', completed: '已完成画面操作', needsApproval: true, permissionAction: '操作当前页面画面' },
  drag: { title: '拖动页面内容', running: '正在拖动页面内容', completed: '已完成拖动', needsApproval: true, permissionAction: '拖动当前网页中的内容' },
  scroll: { title: '浏览页面', running: '正在浏览页面内容', completed: '已浏览页面内容', needsApproval: false },
  wait: { title: '等待页面响应', running: '正在等待页面更新', completed: '页面已响应', needsApproval: false },
  assert: { title: '验证页面结果', running: '正在核对页面结果', completed: '已核对页面结果', needsApproval: false },
  diagnostics: { title: '检查页面问题', running: '正在检查页面状态', completed: '已完成页面检查', needsApproval: false },
  back: { title: '返回上一页', running: '正在返回上一页', completed: '已返回上一页', needsApproval: false },
  forward: { title: '前往下一页', running: '正在前往下一页', completed: '已前往下一页', needsApproval: false },
  reload: { title: '刷新页面', running: '正在刷新页面', completed: '页面已刷新', needsApproval: false },
  screenshot: { title: '保存页面截图', running: '正在保存当前画面', completed: '页面截图已保存', needsApproval: false },
  set_layout: { title: '调整浏览器布局', running: '正在调整浏览器布局', completed: '浏览器布局已调整', needsApproval: false },
  close: { title: '关闭网页', running: '正在关闭网页', completed: '网页已关闭', needsApproval: false },
}

export function isBuiltInBrowserTool(name: string): boolean {
  return name.startsWith(BROWSER_TOOL_PREFIX)
}

export function browserToolNeedsApproval(name: string): boolean | null {
  if (!isBuiltInBrowserTool(name)) return null
  return BROWSER_TOOLS[browserOperation(name)]?.needsApproval ?? true
}

export function browserPermissionGrantGroup(name: string): string | undefined {
  return browserToolNeedsApproval(name) === true ? 'browser-actions' : undefined
}

export function describeBrowserToolActivity(
  name: string,
  args: Record<string, unknown>,
  status: BrowserToolActivityStatus,
): BrowserToolActivityPresentation | null {
  if (!isBuiltInBrowserTool(name)) return null
  const definition = BROWSER_TOOLS[browserOperation(name)] ?? {
    title: '使用内置浏览器',
    running: '正在处理网页任务',
    completed: '已完成网页任务',
    needsApproval: true,
  }
  const target = browserTarget(args)
  const detail = status === 'failed'
    ? '暂未完成，智能代理将调整处理方式'
    : appendTarget(status === 'running' ? definition.running : definition.completed, target)
  return {
    title: definition.title,
    detail,
    needsApproval: definition.needsApproval,
  }
}

export function describeBrowserPermission(
  name: string,
  args: Record<string, unknown>,
): BrowserPermissionPresentation | null {
  if (!isBuiltInBrowserTool(name)) return null
  const definition = BROWSER_TOOLS[browserOperation(name)]
  if (!definition?.needsApproval) return null
  const action = definition.permissionAction || '操作当前网页'
  const target = browserTarget(args)
  return {
    title: definition.title,
    question: `允许 TurboFlux ${appendTarget(action, target)}吗？`,
    reason: definition.permissionReason || '这会与当前网页交互，并可能改变页面状态。',
    runningDetail: appendTarget(definition.running, target),
  }
}

function browserOperation(name: string): string {
  return name.slice(BROWSER_TOOL_PREFIX.length)
}

function browserTarget(args: Record<string, unknown>): string | undefined {
  const value = typeof args.url === 'string' ? args.url.trim() : ''
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!value) return query ? `“${query.replace(/\s+/g, ' ').slice(0, 36)}”` : undefined
  try {
    const parsed = new URL(value)
    return parsed.hostname || undefined
  } catch {
    const compact = value.replace(/\s+/g, ' ').slice(0, 36)
    return compact ? `“${compact}”` : undefined
  }
}

function appendTarget(text: string, target?: string): string {
  return target ? `${text} · ${target}` : text
}
