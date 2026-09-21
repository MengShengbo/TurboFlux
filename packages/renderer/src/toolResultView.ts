import { CircleAlert, ExternalLink, FileText, GitBranch, Terminal, createElement } from 'lucide'
import type { AgentAttachment, ChangeSummary, TaskFlowNode, ToolCall, ToolResult, ToolResultData } from '@turboflux/presentation'
import { copyContentButton } from './sourceView'
import { createRetrievalView } from './retrievalView'
import { toolActivityStatus, toolActivitySummary } from './toolActivityPresentation'
import { createToolResultDisclosure } from './toolResultDisclosure'

export interface ToolResultViewOptions {
  renderMarkdown(host: HTMLElement, source: string): void
  renderDiffPreview(host: HTMLElement, change: ChangeSummary): void
  onPreviewDiff?: (change: ChangeSummary) => void
  onOpenBrowser?: () => void
  createImagePreview?: (attachment: AgentAttachment) => HTMLElement
  status?: TaskFlowNode['status']
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
  anchor.title = href
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
const INTERNAL_FIELDS = new Set(['id', 'callid', 'toolcallid', 'sessionid', 'tabid', 'schemaversion', 'inputschema', 'metadata', 'debug', 'diagnostics', 'token', 'apikey', 'authorization', 'requestid', 'observationid', 'runid', 'turnid', 'conversationid', 'traceid', 'createdat', 'updatedat', 'elapsedms', 'durationms'])

function resultFields(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).filter(([key, content]) => content !== undefined && content !== null
    && !INTERNAL_FIELDS.has(key.replaceAll('_', '').toLowerCase())
    && !(['ok', 'success'].includes(key) && content === true))
}

function longResultText(text: string): boolean {
  return text.length > 480 || text.split('\n').length > 6 || text.includes('```')
}

function appendResultText(host: HTMLElement, text: string, options: ToolResultViewOptions, label: string, key = label): void {
  if (!text.trim()) return
  const render = (body: HTMLElement) => {
    const content = document.createElement('div')
    content.className = 'tool-result-prose'
    options.renderMarkdown(content, text)
    body.append(content)
  }
  if (longResultText(text)) host.append(createToolResultDisclosure(key, label, render))
  else render(host)
}

function resultContentLabel(call: ToolCall): string {
  if (call.name.startsWith('computer__')) return '电脑操作记录'
  return ({ git_diff: '代码差异', git_log: '提交记录', git_show: '提交内容', use_skill: '技能内容',
    read_agent: '协作记录', spawn_agent: '协作任务', create_task: '任务计划', create_tasks: '任务计划', update_task: '任务计划', list_tasks: '任务计划',
  } as Record<string, string>)[call.name] || '返回内容'
}

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
    const fields = resultFields(value as Record<string, unknown>)
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
  const command = textElement('span', data.command ? `$ ${data.command.replace(/\s+/g, ' ').trim()}` : '运行输出')
  command.title = [data.command, data.cwd].filter(Boolean).join('\n')
  header.append(command)
  const state = data.timedOut ? '执行超时' : data.exitCode !== undefined && data.exitCode !== 0 ? `退出码 ${data.exitCode}` : failed ? '执行失败' : data.status === 'running' ? '运行中' : ''
  if (state) header.append(textElement('small', state, failed || (data.exitCode !== undefined && data.exitCode !== 0) ? 'is-error' : ''))
  if (data.command) header.append(copyContentButton(data.command, '复制命令'))
  host.append(header)
  if (data.command && (data.command.includes('\n') || data.command.length > 160)) {
    host.append(createToolResultDisclosure('command-source', '完整命令', body => body.append(textElement('pre', `$ ${data.command}`, 'tool-command-source'))))
  }
  const error = cleanResultText(data.error || (failed ? data.stderr || '' : ''))
  if (error) {
    host.append(textElement('p', error.length > 320 ? `${error.slice(0, 320)}…` : error, 'tool-command-error'))
    if (error.length > 320) host.append(createToolResultDisclosure('command-error', '完整错误信息', body => body.append(textElement('pre', error, 'tool-command-log'))))
  }
  const logs = [cleanResultText(data.stdout), cleanResultText(data.stderr || '')].filter(Boolean).join('\n')
  if (logs && logs !== error) {
    const render = (body: HTMLElement) => body.append(textElement('pre', logs, 'tool-command-log'))
    if (longResultText(logs)) host.append(createToolResultDisclosure('command-log', '运行输出', render))
    else render(host)
  }
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
    const text = value.text
    if (text.trim()) host.append(createToolResultDisclosure('browser-text', '页面内容', body => {
      // Browser observations are visible page text, not Markdown instructions.
      body.append(textElement('p', text, 'tool-browser-text'))
    }))
  }
  const elements = Array.isArray(value.matches) ? value.matches : Array.isArray(value.elements) ? value.elements : undefined
  if (elements?.length) host.append(createToolResultDisclosure('browser-elements', value.matches ? '匹配控件' : '页面控件', body => {
    const list = document.createElement('div')
    list.className = 'tool-browser-elements'
    const roles: Record<string, string> = { button: '按钮', link: '链接', textbox: '文本框', checkbox: '复选框', radio: '单选项', combobox: '选择框', heading: '标题', tab: '标签页', menuitem: '菜单项', option: '选项', img: '图片' }
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue
      const row = document.createElement('div')
      row.append(textElement('small', roles[element.role] || '控件'))
      row.append(textElement('span', String(element.name || element.description || '未命名')))
      if (element.disabled) row.append(textElement('small', '不可用'))
      else if (typeof element.checked === 'boolean') row.append(textElement('small', element.checked ? '已选择' : '未选择'))
      list.append(row)
    }
    body.append(list)
  }))
  if (value.passed === false) host.append(textElement('p', '页面检查未通过', 'tool-command-error'))
  if (value.truncated === true) host.append(textElement('p', '本次读取了部分页面内容', 'tool-result-note'))
  for (const [key, label] of [['console', '控制台记录'], ['network', '网络记录']]) {
    const entries = value[key]
    if (Array.isArray(entries) && entries.length) host.append(createToolResultDisclosure(`browser-${key}`, label, body => renderStructured(body, entries, options)))
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
  options = { ...options, status: toolActivityStatus({ status: options.status || 'running', settled: false }, result) }
  const host = createToolResultContent(call, result, options)
  host.dataset.resultCallId = call.id
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
  if (!result) {
    const target = String(call.arguments.path || call.arguments.command || call.arguments.query || call.arguments.pattern || call.arguments.url || '')
    if (target) host.append(textElement('p', target, 'tool-result-target'))
    const message = options.status === 'completed' ? '操作已完成，暂无结果详情'
      : options.status === 'failed' ? '操作失败，暂无结果详情'
        : options.status === 'cancelled' || options.status === 'interrupted' ? '操作已停止'
          : options.status === 'paused' ? '操作已暂停'
            : options.status === 'waiting' ? '等待执行' : '正在执行'
    host.append(textElement('p', message, 'tool-result-empty'))
    return host
  }
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
    const message = output.replace(/^Error:\s*/i, '')
    copy.append(textElement('p', message.length > 320 ? `${message.slice(0, 320)}…` : message))
    if (message.length > 320) copy.append(createToolResultDisclosure('error', '完整错误信息', body => body.append(textElement('p', message))))
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
    const change = result.changeSummary
    host.append(createToolResultDisclosure('diff', change.path, body => options.renderDiffPreview(body, change)))
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
    if (snapshot.clean) header.append(textElement('span', '工作区干净'))
    host.append(header)
    const list = document.createElement('div')
    list.className = 'tool-repository-files'
    for (const file of snapshot.files) {
      const row = document.createElement('div')
      const path = textElement('code', file.path)
      path.title = file.path
      row.append(createElement(FileText, { width: 14, height: 14, 'aria-hidden': 'true' }), path)
      row.append(textElement('span', file.conflicted ? '冲突' : file.untracked ? '未跟踪' : file.staged && file.unstaged ? '部分暂存' : file.staged ? '已暂存' : '已修改'))
      list.append(row)
    }
    host.append(list)
    return host
  }
  if (data?.kind === 'web_search') {
    const list = document.createElement('div')
    list.className = 'tool-web-sources'
    for (const [index, source] of data.response.results.entries()) {
      const article = document.createElement('article')
      const title = link(source.title || source.url, source.url)
      if (source.snippet) article.append(createToolResultDisclosure(`web-source:${index}:${source.url}`, title, body => body.append(textElement('p', source.snippet!))))
      else article.append(title)
      list.append(article)
    }
    host.append(list)
    if (!data.response.results.length) host.append(textElement('p', '没有找到相关网页', 'tool-result-empty'))
    if (data.response.partial) host.append(textElement('p', '部分来源未能完成搜索', 'tool-result-note'))
    return host
  }
  if (data?.kind === 'web_fetch') {
    for (const [index, page] of data.response.pages.entries()) {
      const article = document.createElement('article')
      article.className = 'tool-web-page'
      article.append(createToolResultDisclosure(`web-page:${index}:${page.url}`, link(page.title || page.url, page.finalUrl || page.url), body => {
        const text = document.createElement('div')
        text.className = 'tool-web-page-text'
        options.renderMarkdown(text, page.text)
        body.append(text)
        if (page.truncated) body.append(textElement('small', '本次读取了部分网页内容'))
      }))
      host.append(article)
    }
    for (const failure of data.response.failures) host.append(textElement('p', `${failure.url}：${failure.error}`, 'tool-result-note'))
    return host
  }
  if (data?.kind === 'items') {
    if (!data.items.length) host.append(textElement('p', '没有相关结果', 'tool-result-empty'))
    for (const [index, item] of data.items.entries()) {
      const row = document.createElement('article')
      row.className = 'tool-result-item'
      const longTitle = item.title.length > 120 || longResultText(item.title)
      if (item.description || longTitle) {
        const detail = createToolResultDisclosure(`item:${index}:${item.path || item.title.slice(0, 80)}`, item.title.replace(/\s+/g, ' ').trim(), body => {
          if (longTitle) {
            const title = document.createElement('div')
            title.className = 'tool-result-prose'
            options.renderMarkdown(title, item.title)
            body.append(title)
          }
          if (item.description) {
            const description = document.createElement('div')
            description.className = 'tool-result-prose'
            options.renderMarkdown(description, item.description)
            body.append(description)
          }
        })
        if (item.status) detail.querySelector('summary')!.append(textElement('small', STATUS_LABELS[item.status] || item.status))
        row.append(detail)
      } else {
        row.append(textElement('strong', item.title))
        if (item.status) row.append(textElement('span', STATUS_LABELS[item.status] || item.status))
      }
      if (item.path) row.title = item.path
      host.append(row)
    }
    return host
  }
  if ((call.name === 'remember' || call.name === 'notify_user') && !result?.interruption) {
    appendResultText(host, String(call.arguments.text || call.arguments.message || output), options, call.name === 'remember' ? '记忆内容' : '通知内容')
    return host
  }
  let value: unknown = output
  try { value = JSON.parse(output) } catch { /* Older tools return plain text. */ }
  if (typeof value === 'string') {
    if (call.name === 'git_diff' || call.name === 'git_show') {
      host.append(createToolResultDisclosure('repository-output', resultContentLabel(call), body => body.append(textElement('pre', value as string, 'tool-result-raw'))))
    } else appendResultText(host, value, options, resultContentLabel(call))
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = resultFields(value as Record<string, unknown>)
    const primary = ['error', 'warning', 'message', 'summary', 'title'].map(name => fields.find(([key, content]) => key === name && typeof content === 'string' && content.trim())).find(Boolean)
    if (primary) {
      if (['error', 'warning'].includes(primary[0]) && longResultText(primary[1] as string)) host.append(textElement('p', `${(primary[1] as string).slice(0, 320)}…`, 'tool-command-error'))
      appendResultText(host, primary[1] as string, options, '完整说明', 'result-summary')
    }
    const remaining = Object.fromEntries(fields.filter(([key]) => key !== primary?.[0] && !(primary && key === 'status' && ['completed', 'success'].includes(String((value as Record<string, unknown>).status)))))
    if (Object.keys(remaining).length) host.append(createToolResultDisclosure('result-fields', resultContentLabel(call), body => renderStructured(body, remaining, options)))
  } else if (Array.isArray(value)) {
    if (value.length) host.append(createToolResultDisclosure('result-list', resultContentLabel(call), body => renderStructured(body, value, options)))
    else host.append(textElement('p', '没有相关结果', 'tool-result-empty'))
  } else renderStructured(host, value, options)
  if (!host.childElementCount) host.append(textElement('p', '操作已完成', 'tool-result-empty'))
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
