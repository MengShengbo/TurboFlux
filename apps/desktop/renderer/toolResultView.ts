import { Check, CircleAlert, ExternalLink, FileText, GitBranch, Terminal, createElement } from 'lucide'
import type { AgentAttachment, ChangeSummary, ToolCall, ToolResult, ToolResultData } from '@turboflux/agent-core/renderer'
import { copyContentButton } from './sourceView'
import { createRetrievalView } from './retrievalView'
import { toolActivitySummary } from './toolActivityPresentation'

export interface ToolResultViewOptions {
  renderMarkdown(host: HTMLElement, source: string): void
  renderDiffPreview(host: HTMLElement, change: ChangeSummary): void
  onPreviewDiff?: (change: ChangeSummary) => void
  onOpenBrowser?: () => void
  createImagePreview?: (attachment: AgentAttachment) => HTMLElement
  status?: string
}

function textElement(tag: string, text: string, className = ''): HTMLElement {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

function link(title: string, url: string): HTMLElement {
  const href = safeUrl(url)
  if (!href) return textElement('span', title)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.textContent = title || new URL(href).hostname
  anchor.append(createElement(ExternalLink, { width: 12, height: 12, 'aria-hidden': 'true' }))
  return anchor
}

export function cleanResultText(value: string): string {
  return value
    .replace(/<\s*(tool_retry_hint|runtime_context|additional_instructions|recent_files)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
    .trim()
}

const STATUS_LABELS: Record<string, string> = {
  running: '运行中', completed: '已完成', failed: '失败', exited: '已退出', waiting: '等待中',
  pending: '待处理', paused: '已暂停', cancelled: '已停止', interrupted: '已中断', stopped: '已停止',
}

const FIELD_LABELS: Record<string, string> = {
  title: '名称', name: '名称', description: '说明', path: '路径', url: '网址', status: '状态',
  message: '结果', text: '内容', content: '内容', summary: '摘要', detail: '详情', error: '原因',
  reason: '原因', source: '来源', query: '搜索词', count: '数量', total: '合计', label: '名称',
  files: '文件', items: '条目', results: '结果', tasks: '任务', tools: '工具', matches: '匹配',
  branch: '分支', author: '作者', subject: '提交说明', createdAt: '创建时间', updatedAt: '更新时间',
  objective: '目标', progress: '进度', success: '完成状态', ok: '完成状态', selected: '已选择',
}
const INTERNAL_FIELDS = new Set(['id', 'callId', 'toolCallId', 'sessionId', 'tabId', 'schemaVersion', 'inputSchema', 'metadata', 'debug', 'diagnostics', 'token', 'apiKey', 'authorization', 'requestId'])

function renderStructured(host: HTMLElement, value: unknown, options: ToolResultViewOptions, depth = 0): void {
  if (typeof value === 'string') {
    const content = document.createElement('div')
    content.className = 'tool-result-prose'
    options.renderMarkdown(content, value)
    host.append(content)
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) { host.append(textElement('p', '没有相关结果', 'tool-result-empty')); return }
    const list = document.createElement('ul')
    list.className = 'tool-result-items'
    for (const item of value) {
      const row = document.createElement('li')
      renderStructured(row, item, options, depth + 1)
      list.append(row)
    }
    host.append(list)
    return
  }
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).filter(([key]) => !INTERNAL_FIELDS.has(key))
    const list = document.createElement('dl')
    list.className = 'tool-result-fields'
    for (const [key, content] of fields) {
      if (content === undefined || content === null || depth > 4) continue
      const label = textElement('dt', FIELD_LABELS[key] || key.replaceAll('_', ' '))
      const detail = document.createElement('dd')
      if (typeof content === 'boolean') detail.append(textElement('span', content ? '是' : '否'))
      else if (key === 'status' && typeof content === 'string') detail.append(textElement('span', STATUS_LABELS[content] || content))
      else if (key === 'url' && typeof content === 'string') detail.append(link(content, content))
      else renderStructured(detail, content, options, depth + 1)
      list.append(label, detail)
    }
    host.append(list)
    return
  }
  if (value !== undefined && value !== null) host.append(textElement('span', String(value)))
}

function renderCommand(host: HTMLElement, data: Extract<ToolResultData, { kind: 'command' }>, failed: boolean): void {
  host.classList.add('tool-command')
  const header = document.createElement('div')
  header.className = 'tool-command-heading'
  header.append(createElement(Terminal, { width: 14, height: 14, 'aria-hidden': 'true' }))
  header.append(textElement('span', data.cwd || '终端'))
  const state = data.timedOut ? '执行超时' : data.exitCode !== undefined ? `退出码 ${data.exitCode}` : STATUS_LABELS[data.status || ''] || (failed ? '执行失败' : '运行中')
  header.append(textElement('small', state, failed || (data.exitCode !== undefined && data.exitCode !== 0) ? 'is-error' : ''))
  if (data.command) header.append(copyContentButton(data.command, '复制命令'))
  host.append(header)
  if (data.command) host.append(textElement('pre', `$ ${data.command}`, 'tool-command-source'))
  if (data.error) host.append(textElement('p', cleanResultText(data.error), 'tool-command-error'))
  const logs = [cleanResultText(data.stdout), cleanResultText(data.stderr || '')].filter(Boolean).join('\n')
  if (logs) host.append(textElement('pre', logs, 'tool-command-log'))
  else host.append(textElement('p', data.status === 'running' ? '进程已启动，暂无新输出' : '没有终端输出', 'tool-result-empty'))
  if (data.truncated) host.append(textElement('p', '当前显示部分运行记录', 'tool-result-note'))
}

function renderBrowser(host: HTMLElement, value: Record<string, unknown>, options: ToolResultViewOptions): void {
  if (typeof value.url === 'string') host.append(link(String(value.title || value.url), value.url))
  const tabs = Array.isArray(value.tabs) ? value.tabs : []
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object' || typeof tab.url !== 'string') continue
    const row = document.createElement('article')
    row.className = 'tool-result-item'
    row.append(link(String(tab.title || tab.url), tab.url))
    if (tab.id === value.activeTabId) row.append(textElement('span', '当前页面'))
    host.append(row)
  }
  if (typeof value.text === 'string') {
    const text = document.createElement('div')
    text.className = 'tool-web-page-text'
    // Browser observations are visible page text, not Markdown instructions.
    text.append(textElement('p', value.text, 'tool-browser-text'))
    host.append(text)
  }
  const elements = Array.isArray(value.matches) ? value.matches : Array.isArray(value.elements) ? value.elements : undefined
  if (elements) {
    const list = document.createElement('div')
    list.className = 'tool-browser-elements'
    const roles: Record<string, string> = { button: '按钮', link: '链接', textbox: '文本框', checkbox: '复选框', radio: '单选项', combobox: '选择框', heading: '标题', tab: '标签页', menuitem: '菜单项', option: '选项', img: '图片' }
    list.append(textElement('p', `${elements.length} 个页面控件`, 'tool-result-note'))
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue
      const row = document.createElement('div')
      row.append(textElement('small', roles[element.role] || '控件'))
      row.append(textElement('span', String(element.name || element.description || '未命名')))
      if (element.disabled) row.append(textElement('small', '不可用'))
      else if (typeof element.checked === 'boolean') row.append(textElement('small', element.checked ? '已选择' : '未选择'))
      list.append(row)
    }
    host.append(list)
  }
  const actions: Record<string, string> = { clicked: '已点击', filled: '已填写', hovered: '已悬停', key: '已按键' }
  for (const [key, label] of Object.entries(actions)) {
    if (typeof value[key] === 'string') host.append(textElement('p', `${label}：${value[key]}`, 'tool-result-note'))
  }
  if (typeof value.checked === 'boolean') host.append(textElement('p', value.checked ? '已勾选' : '已取消勾选', 'tool-result-note'))
  if (Array.isArray(value.selected)) host.append(textElement('p', `已选择：${value.selected.join('、')}`, 'tool-result-note'))
  if (value.submitted === true) host.append(textElement('p', '已提交', 'tool-result-note'))
  if (value.changed === true) host.append(textElement('p', '页面已更新', 'tool-result-note'))
  if (typeof value.direction === 'string') {
    const direction = ({ up: '上', down: '下', left: '左', right: '右' } as Record<string, string>)[value.direction]
    if (direction) host.append(textElement('p', `已向${direction}滚动`, 'tool-result-note'))
  }
  if (typeof value.passed === 'boolean') host.append(textElement('p', value.passed ? '页面检查通过' : '页面检查未通过', 'tool-result-note'))
  if (value.truncated === true) host.append(textElement('p', '本次读取了部分页面内容', 'tool-result-note'))
  if (Array.isArray(value.console) || Array.isArray(value.network)) {
    const entries = [...(Array.isArray(value.console) ? value.console : []), ...(Array.isArray(value.network) ? value.network : [])]
    if (!entries.length) host.append(textElement('p', '没有记录到网页运行问题', 'tool-result-empty'))
    else renderStructured(host, entries, options)
  }
  if (options.onOpenBrowser) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tool-result-open'
    button.append(createElement(ExternalLink, { width: 14, height: 14, 'aria-hidden': 'true' }), document.createTextNode('打开页面'))
    button.onclick = options.onOpenBrowser
    host.append(button)
  }
}

export function createToolResultView(call: ToolCall, result: ToolResult | undefined, options: ToolResultViewOptions): HTMLElement {
  const host = createToolResultContent(call, result, options)
  if ((!result && options.status === 'paused') || result?.interruption) {
    if (!result) {
      host.replaceChildren()
      const target = String(call.arguments.path || call.arguments.command || call.arguments.query || call.arguments.url || '')
      if (target) host.append(textElement('p', target, 'tool-result-target'))
    }
    const status = !result ? '操作已暂停' : result.interruption?.kind === 'pause' ? '操作已中断（任务暂停）' : '操作已停止'
    host.prepend(textElement('p', status, 'tool-result-note'))
  }
  return host
}

function createToolResultContent(call: ToolCall, result: ToolResult | undefined, options: ToolResultViewOptions): HTMLElement {
  const host = document.createElement('section')
  host.className = 'tool-result-view'
  const output = cleanResultText(result?.output || '')
  const data = result?.data
  if (data?.kind === 'command') { renderCommand(host, data, result?.isError === true); return host }
  if (call.name === 'run_command' || call.name === 'read_terminal') {
    renderCommand(host, { kind: 'command', command: String(call.arguments.command || ''), cwd: String(call.arguments.cwd || ''), stdout: output, status: options.status }, result?.isError === true)
    return host
  }
  if (result?.isError && !result.interruption) {
    host.classList.add('tool-result-error')
    host.append(createElement(CircleAlert, { width: 16, height: 16, 'aria-hidden': 'true' }))
    const copy = document.createElement('div')
    copy.append(textElement('strong', toolActivitySummary(call, result)))
    const location = String(call.arguments.path || call.arguments.query || call.arguments.pattern || '')
    if (location) copy.append(textElement('code', location))
    copy.append(textElement('p', output.replace(/^Error:\s*/i, '')))
    host.append(copy)
    return host
  }
  for (const attachment of result?.attachments || []) {
    if (attachment.type === 'image' && options.createImagePreview) host.append(options.createImagePreview(attachment))
  }
  if (call.name.startsWith('browser__') && result) {
    let value: unknown
    try { value = JSON.parse(output) } catch { /* Historical operations can return plain text. */ }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      renderBrowser(host, value as Record<string, unknown>, options)
      if (!host.childElementCount && !result.interruption) host.append(textElement('p', '操作已完成', 'tool-result-empty'))
      return host
    }
  }
  if (result?.retrieval) { host.append(createRetrievalView(result.retrieval)); return host }
  if (result?.changeSummary) {
    host.classList.add('tool-change-result')
    options.renderDiffPreview(host, result.changeSummary)
    if (options.onPreviewDiff) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tool-result-open'
      button.append(createElement(ExternalLink, { width: 14, height: 14, 'aria-hidden': 'true' }), document.createTextNode('查看文件差异'))
      button.onclick = () => options.onPreviewDiff?.(result.changeSummary!)
      host.append(button)
    }
    return host
  }
  if (data?.kind === 'repository') {
    const snapshot = data.snapshot
    const header = document.createElement('div')
    header.className = 'tool-repository-heading'
    header.append(createElement(GitBranch, { width: 15, height: 15, 'aria-hidden': 'true' }), textElement('strong', snapshot.branch || '分离的 HEAD'))
    header.append(textElement('span', snapshot.clean ? '工作区干净' : `${snapshot.files.length} 个文件有改动`))
    host.append(header)
    const list = document.createElement('div')
    list.className = 'tool-repository-files'
    for (const file of snapshot.files) {
      const row = document.createElement('div')
      row.append(createElement(FileText, { width: 14, height: 14, 'aria-hidden': 'true' }), textElement('code', file.path))
      row.append(textElement('span', file.conflicted ? '冲突' : file.untracked ? '未跟踪' : file.staged && file.unstaged ? '部分暂存' : file.staged ? '已暂存' : '已修改'))
      list.append(row)
    }
    host.append(list)
    return host
  }
  if (data?.kind === 'web_search') {
    const list = document.createElement('div')
    list.className = 'tool-web-sources'
    for (const source of data.response.results) {
      const article = document.createElement('article')
      const url = safeUrl(source.url)
      article.append(link(source.title || source.url, source.url), textElement('small', source.domain || (url ? new URL(url).hostname : source.url)))
      if (source.snippet) article.append(textElement('p', source.snippet))
      list.append(article)
    }
    host.append(list)
    if (!data.response.results.length) host.append(textElement('p', '没有找到相关网页', 'tool-result-empty'))
    if (data.response.partial) host.append(textElement('p', '部分来源未能完成搜索', 'tool-result-note'))
    return host
  }
  if (data?.kind === 'web_fetch') {
    for (const page of data.response.pages) {
      const article = document.createElement('article')
      article.className = 'tool-web-page'
      article.append(link(page.title || page.url, page.finalUrl || page.url))
      const text = document.createElement('div')
      text.className = 'tool-web-page-text'
      options.renderMarkdown(text, page.text)
      article.append(text)
      if (page.truncated) article.append(textElement('small', '本次读取了部分网页内容'))
      host.append(article)
    }
    for (const failure of data.response.failures) host.append(textElement('p', `${failure.url}：${failure.error}`, 'tool-result-note'))
    return host
  }
  if (data?.kind === 'items') {
    if (!data.items.length) host.append(textElement('p', '没有相关结果', 'tool-result-empty'))
    for (const item of data.items) {
      const row = document.createElement('article')
      row.className = 'tool-result-item'
      row.append(textElement('strong', item.title))
      if (item.status) row.append(textElement('span', STATUS_LABELS[item.status] || item.status))
      if (item.description) row.append(textElement('p', item.description))
      if (item.path) row.append(textElement('small', item.path))
      host.append(row)
    }
    return host
  }
  if ((call.name === 'remember' || call.name === 'notify_user') && !result?.interruption) {
    host.append(createElement(Check, { width: 14, height: 14, 'aria-hidden': 'true' }))
    host.append(textElement('p', String(call.arguments.text || call.arguments.message || output)))
    return host
  }
  if (!result) {
    const target = String(call.arguments.path || call.arguments.query || call.arguments.pattern || call.arguments.url || '')
    if (target) host.append(textElement('p', target, 'tool-result-target'))
    host.append(textElement('p', options.status === 'cancelled' || options.status === 'interrupted' ? '操作已停止' : '正在执行', 'tool-result-empty'))
    return host
  }
  let value: unknown = output
  try { value = JSON.parse(output) } catch { /* Older tools return plain text. */ }
  renderStructured(host, value, options)
  if (options.onOpenBrowser) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tool-result-open'
    button.append(createElement(ExternalLink, { width: 14, height: 14, 'aria-hidden': 'true' }), document.createTextNode('打开页面'))
    button.onclick = options.onOpenBrowser
    host.append(button)
  }
  return host
}
