import hljs from 'highlight.js/lib/common'
import { marked } from 'marked'
import {
  canComputeDiff,
  computeHunks,
  describeBrowserToolActivity,
  describeComputerToolActivity,
  stripTextToolCallMarkup,
  summarizeHunks,
  type ChangeSummary,
  type AgentAttachment,
  type ThinkingTrace,
  type ToolCall,
  type ToolResult,
} from '@turboflux/presentation'
import { classifyExecutionStep } from './executionPresentation'
import { toolActivityDefinition, toolActivityIcon, toolActivitySummary } from './toolActivityPresentation'
import { createToolResultView } from './toolResultView'

const rightChevronIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
const downChevronIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'


const SAFE_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'IMG', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH',
  'THEAD', 'TR', 'UL',
])
const DROP_TAGS = new Set([
  'BUTTON', 'EMBED', 'FORM', 'IFRAME', 'INPUT', 'LINK', 'MATH', 'META', 'OBJECT',
  'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEXTAREA',
])
const INTERNAL_RUNTIME_TOOLS = new Set([
  'set_response_mode',
  'start_background_command', 'read_terminal', 'write_terminal',
  'kill_terminal', 'list_terminals',
])

export interface ToolActivityOptions {
  onPreviewDiff?: (change: ChangeSummary) => void
  onOpenBrowser?: () => void
  createImagePreview?: (attachment: AgentAttachment) => HTMLElement
  animate?: boolean
}

export function isInternalRuntimeTool(name: string): boolean {
  return INTERNAL_RUNTIME_TOOLS.has(name)
}

const renderedMarkdown = new WeakMap<HTMLElement, { source: string; decorate: boolean }>()

export function renderMarkdown(container: HTMLElement, source: string, streaming = false, decorate = true): void {
  container.classList.add('markdown-body')
  container.classList.toggle('markdown-streaming', streaming)
  const previous = renderedMarkdown.get(container)
  if (previous?.source === source && previous.decorate === decorate) return
  renderedMarkdown.set(container, { source, decorate })
  if (!source.trim()) {
    container.replaceChildren()
    return
  }

  const rendered = marked.parse(source, { async: false, breaks: true, gfm: true }) as string
  const template = document.createElement('template')
  template.innerHTML = rendered
  sanitizeFragment(template.content)
  container.replaceChildren(template.content.cloneNode(true))
  if (decorate) decorateCodeBlocks(container)
}

export function normalizeThinkingContent(source: string): string {
  return stripTextToolCallMarkup(source, { stripIncomplete: true })
    .replace(/<\s*tool_retry_hint\b[^>]*>[\s\S]*?(?:<\s*\/\s*tool_retry_hint\s*>|$)/gi, '')
    .replace(/<\s*(runtime_context|additional_instructions|recent_files)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/^[\t ]*```[^\n]*$/gm, '')
    .replace(/```(?:[a-z0-9_+-]+)?/gi, '')
    .split(/\r?\n/)
    .filter(line => !isProtocolNoiseLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isProtocolNoiseLine(line: string): boolean {
  const value = line.trim()
  if (!value) return false
  if (/^<\/?(?:tool_retry_hint|tool_calls|invoke|parameter|runtime_context|additional_instructions|recent_files)\b/i.test(value)) return true
  if (/^(?:row\d+|col\d+)\s*:/i.test(value) && value.length > 56) return true
  if (value.length < 64) return false
  const protocolCharacters = value.match(/[A-Z0-9_.:<>-]/g)?.length || 0
  const repeatedRuns = value.match(/([A-Z.<>_-])\1{3,}/g)?.length || 0
  return repeatedRuns >= 2 && protocolCharacters / value.length > .42
}

function renderThinkingContent(container: HTMLElement, source: string, streaming: boolean): void {
  const normalized = normalizeThinkingContent(source)
  container.classList.toggle('thinking-content-streaming', streaming)
  container.classList.remove('markdown-body', 'markdown-streaming')
  container.textContent = normalized || (streaming ? '正在整理思路…' : '')
}

export function createThinkingBlock(
  trace: ThinkingTrace,
  options: { streaming?: boolean; expanded?: boolean } = {},
): HTMLElement {
  const block = document.createElement('section')
  block.className = `thinking-block${options.streaming ? ' streaming' : ''}`
  const toggle = document.createElement('button')
  toggle.className = 'thinking-toggle'
  toggle.type = 'button'
  const label = document.createElement('span')
  label.className = 'thinking-label'
  const meta = document.createElement('span')
  meta.className = 'thinking-meta'
  const chevron = document.createElement('span')
  chevron.className = 'thinking-chevron'
  chevron.innerHTML = rightChevronIcon
  toggle.append(label, chevron, meta)
  const body = document.createElement('div')
  body.className = 'thinking-body'
  body.setAttribute('aria-hidden', 'true')
  const content = document.createElement('div')
  content.className = 'thinking-content'
  body.append(content)
  block.append(toggle, body)
  toggle.setAttribute('aria-expanded', 'false')
  toggle.addEventListener('click', () => {
    const expanded = !block.classList.contains('expanded')
    block.dataset.userExpanded = String(expanded)
    setThinkingBlockExpanded(block, expanded)
  })
  updateThinkingBlock(block, trace, options.streaming === true)
  if (options.expanded === true) window.requestAnimationFrame(() => setThinkingBlockExpanded(block, true))
  return block
}

export function setThinkingBlockExpanded(block: HTMLElement, expanded: boolean): void {
  block.classList.toggle('expanded', expanded)
  block.querySelector<HTMLElement>('.thinking-toggle')?.setAttribute('aria-expanded', String(expanded))
  block.querySelector<HTMLElement>('.thinking-body')?.setAttribute('aria-hidden', String(!expanded))
}

export function settleThinkingBlock(block: HTMLElement, trace?: ThinkingTrace): void {
  if (trace) updateThinkingBlock(block, trace, false)
  block.classList.remove('streaming')
  block.classList.add('settling')
  window.requestAnimationFrame(() => {
    if (block.dataset.userExpanded !== 'true') setThinkingBlockExpanded(block, false)
    window.setTimeout(() => block.classList.remove('settling'), 480)
  })
}

export function updateThinkingBlock(block: HTMLElement, trace: ThinkingTrace, streaming = false): void {
  block.classList.toggle('streaming', streaming)
  const label = block.querySelector<HTMLElement>('.thinking-label')!
  const meta = block.querySelector<HTMLElement>('.thinking-meta')!
  const content = block.querySelector<HTMLElement>('.thinking-content')!
  label.textContent = trace.status === 'interrupted' ? '思考过程已中断' : '思考过程'
  meta.textContent = streaming ? '进行中' : ''
  renderThinkingContent(content, trace.content || (streaming ? '正在整理思路…' : ''), streaming)
  if (streaming && block.dataset.userExpanded !== 'false' && !block.classList.contains('expanded')) {
    window.requestAnimationFrame(() => {
      if (block.dataset.userExpanded !== 'false') setThinkingBlockExpanded(block, true)
    })
  }
}

export function browserToolResultDetail(name: string, result?: ToolResult): string | undefined {
  if (!name.startsWith('browser__') || !result?.output || result.isError) return undefined
  let value: Record<string, unknown>
  try {
    value = JSON.parse(result.output) as Record<string, unknown>
  } catch {
    return undefined
  }
  const operation = name.slice('browser__'.length)
  if (operation === 'find' && Array.isArray(value.matches)) return value.matches.length ? '已找到匹配控件' : '未找到匹配控件'
  if (operation === 'click' && typeof value.clicked === 'string') {
    return `已点击「${value.clicked.slice(0, 48)}」`
  }
  if (operation === 'type' && typeof value.filled === 'string') return `已填写「${value.filled.slice(0, 48)}」${value.submitted === true ? '并提交' : ''}`
  if (operation === 'press' && typeof value.key === 'string') return `已按下 ${value.key}`
  if (operation === 'select_option' && Array.isArray(value.selected)) return value.selected.length ? `已选择「${value.selected.join('、').slice(0, 48)}」` : '未选择选项'
  if (operation === 'set_checked' && typeof value.checked === 'boolean') return value.checked ? '已勾选目标选项' : '已取消勾选目标选项'
  if (operation === 'hover' && typeof value.hovered === 'string') return `已悬停查看「${value.hovered.slice(0, 48)}」`
  if (operation === 'scroll' && typeof value.direction === 'string') return `已向${({ up: '上', down: '下', left: '左', right: '右' } as Record<string, string>)[value.direction] || ''}浏览页面`
  if (operation === 'drag') return '已完成页面拖动'
  if (operation === 'click_at') return '已点击页面画面'
  return undefined
}

export function browserToolActionTitle(name: string): string | undefined {
  return ({
    browser__activate: '切换浏览标签',
    browser__tabs: '查看浏览标签',
    browser__open: '打开网页',
    browser__navigate: '前往页面',
    browser__wait: '等待网页加载',
    browser__observe: '读取网页',
    browser__visual_observe: '查看网页画面',
    browser__screenshot: '截取网页',
    browser__diagnostics: '检查网页状态',
    browser__find: '查找页面控件',
    browser__click: '点击网页内容',
    browser__click_at: '点击网页画面',
    browser__type: '输入网页内容',
    browser__press: '按下网页按键',
    browser__select_option: '选择网页选项',
    browser__set_checked: '切换网页选项',
    browser__hover: '悬停网页内容',
    browser__scroll: '滚动网页',
    browser__drag: '拖动网页内容',
    browser__upload_file: '上传文件',
    browser__assert: '验证网页结果',
    browser__back: '返回上一页',
    browser__forward: '前往下一页',
    browser__reload: '刷新网页',
    browser__set_layout: '调整浏览器布局',
    browser__close: '关闭网页',
  } as Record<string, string>)[name]
}

export function createToolActivity(
  call: ToolCall,
  result: ToolResult | undefined,
  status: 'running' | 'completed' | 'failed',
  options: ToolActivityOptions = {},
): HTMLElement {
  if (result) status = result.isError ? 'failed' : 'completed'
  const activity = document.createElement('section')
  const isDiff = Boolean(result?.changeSummary)
  const isSemanticRuntime = call.name === 'run_command'
  const browserPresentation = describeBrowserToolActivity(call.name, call.arguments, status)
  const computerPresentation = describeComputerToolActivity(call.name, call.arguments, status)
  const semanticPresentation = computerPresentation || browserPresentation
  const completedBrowserDetail = status === 'completed' ? browserToolResultDetail(call.name, result) : undefined
  const isSemanticActivity = isSemanticRuntime || Boolean(semanticPresentation)
  const category = classifyExecutionStep(call)
  activity.className = `tool-activity ${status} category-${category}${isDiff ? ' diff-activity' : ''}${isSemanticActivity ? ' semantic-runtime-activity' : ''}${browserPresentation ? ' browser-activity' : ''}${computerPresentation ? ' computer-activity' : ''}`
  if (options.animate === false) activity.classList.add('no-entry-motion')
  activity.dataset.toolId = call.id
  activity.dataset.executionCategory = category

  const header = document.createElement('button')
  header.type = 'button'
  header.className = 'tool-activity-header'
  header.setAttribute('aria-expanded', 'false')
  const glyph = document.createElement('span')
  glyph.className = 'tool-activity-glyph'
  glyph.innerHTML = toolActivityIcon(call.name)
  const copy = document.createElement('span')
  copy.className = 'tool-activity-copy'
  const title = document.createElement('strong')
  title.textContent = browserToolActionTitle(call.name) || semanticPresentation?.title
    || (isSemanticRuntime && typeof call.arguments.display_title === 'string'
      ? call.arguments.display_title
      : toolDisplayName(call.name))
  const detail = document.createElement('small')
  detail.textContent = status === 'failed' ? toolActivitySummary(call, result, status) : completedBrowserDetail || semanticPresentation?.detail || toolActivitySummary(call, result, status)
  copy.append(title, detail)
  const state = document.createElement('span')
  state.className = 'tool-activity-state'
  state.textContent = status === 'running' ? '执行中' : status === 'failed' ? '失败' : '完成'
  header.append(glyph, copy, state)

  {
    const chevron = document.createElement('span')
    chevron.className = 'tool-activity-chevron'
    chevron.innerHTML = downChevronIcon
    header.append(chevron)
    const body = document.createElement('div')
    body.className = 'tool-activity-body'
    const bodyInner = document.createElement('div')
    bodyInner.className = 'tool-activity-body-inner'
    bodyInner.append(createToolResultView(call, result, { renderMarkdown, renderDiffPreview, onPreviewDiff: options.onPreviewDiff, onOpenBrowser: options.onOpenBrowser, createImagePreview: options.createImagePreview, status }))
    body.inert = true
    body.append(bodyInner)
    activity.append(header, body)
  }

  header.addEventListener('click', () => {
    const expanded = activity.classList.toggle('expanded')
    header.setAttribute('aria-expanded', String(expanded))
    activity.querySelector<HTMLElement>('.tool-activity-body')!.inert = !expanded
  })
  return activity
}

export function renderDiffPreview(container: HTMLElement, change: ChangeSummary): void {
  container.replaceChildren()
  const header = document.createElement('div')
  header.className = 'diff-preview-header'
  const path = document.createElement('strong')
  path.textContent = change.path
  const stats = document.createElement('span')
  stats.className = 'diff-preview-stats'
  stats.textContent = `+${change.addedLines ?? 0}  −${change.removedLines ?? 0}`
  header.append(path, stats)
  container.append(header)

  if (canComputeDiff(change.before, change.after)) {
    const hunks = computeHunks(change.before!, change.after!)
    const summary = summarizeHunks(hunks)
    stats.textContent = `+${summary.added}  −${summary.removed}`
    const diff = document.createElement('div')
    diff.className = 'diff-preview'
    for (const hunk of hunks) {
      const hunkElement = document.createElement('section')
      hunkElement.className = 'diff-hunk'
      const hunkHeader = document.createElement('div')
      hunkHeader.className = 'diff-hunk-header'
      hunkHeader.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
      hunkElement.append(hunkHeader)
      for (const line of hunk.lines) {
        const row = document.createElement('div')
        row.className = `diff-line ${line.kind}`
        const oldNumber = document.createElement('span')
        oldNumber.textContent = line.oldLine ? String(line.oldLine) : ''
        const newNumber = document.createElement('span')
        newNumber.textContent = line.newLine ? String(line.newLine) : ''
        const marker = document.createElement('span')
        marker.textContent = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '
        const text = document.createElement('code')
        text.textContent = line.text || ' '
        row.append(oldNumber, newNumber, marker, text)
        hunkElement.append(row)
      }
      diff.append(hunkElement)
    }
    if (hunks.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'diff-preview-empty'
      empty.textContent = '文件内容没有变化'
      diff.append(empty)
    }
    container.append(diff)
    return
  }

  const fallback = document.createElement('div')
  fallback.className = 'diff-preview-fallback'
  const message = document.createElement('p')
  message.textContent = change.diffStatus === 'snapshot-too-large'
    ? '文件较大，已保留变更统计和安全预览。'
    : '没有可用于完整对比的前后快照。'
  fallback.append(message)
  const preview = change.preview || change.oldPreview
  if (preview) {
    const pre = document.createElement('pre')
    pre.textContent = preview
    fallback.append(pre)
  }
  container.append(fallback)
}

function sanitizeFragment(fragment: DocumentFragment): void {
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    if (DROP_TAGS.has(element.tagName)) {
      element.remove()
      continue
    }
    if (!SAFE_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }
    const originalHref = element.getAttribute('href') || ''
    const originalSource = element.getAttribute('src') || ''
    const originalAlt = element.getAttribute('alt') || ''
    const originalClass = Array.from(element.classList).find(name => /^language-[a-z0-9_+-]+$/i.test(name))
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name)
    if (element instanceof HTMLAnchorElement) sanitizeAnchor(element, originalHref)
    if (element instanceof HTMLImageElement) sanitizeImage(element, originalSource, originalAlt)
    if (element instanceof HTMLElement && element.tagName === 'CODE') {
      if (originalClass) element.className = originalClass
    }
  }
}

function sanitizeAnchor(anchor: HTMLAnchorElement, rawHref: string): void {
  const safeHref = safeUrl(rawHref, false)
  if (!safeHref) return
  anchor.href = safeHref
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
}

function sanitizeImage(image: HTMLImageElement, rawSource: string, alt: string): void {
  const safeSource = safeUrl(rawSource, true)
  if (!safeSource) {
    image.remove()
    return
  }
  image.src = safeSource
  image.alt = alt
  image.loading = 'lazy'
  image.referrerPolicy = 'no-referrer'
}

function safeUrl(value: string, image: boolean): string | null {
  if (!value) return null
  if (value.startsWith('#') && !image) return value
  if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) return value
  try {
    const parsed = new URL(value, window.location.href)
    if (image) return parsed.protocol === 'https:' ? parsed.href : null
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

function decorateCodeBlocks(container: HTMLElement): void {
  for (const code of Array.from(container.querySelectorAll<HTMLElement>('pre code'))) {
    try {
      hljs.highlightElement(code)
    } catch {}
    const pre = code.parentElement
    if (!pre || pre.parentElement?.classList.contains('code-block')) continue
    const shell = document.createElement('div')
    shell.className = 'code-block'
    const toolbar = document.createElement('div')
    toolbar.className = 'code-toolbar'
    const language = document.createElement('span')
    language.textContent = code.className.match(/language-([\w+-]+)/)?.[1] || 'code'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制'
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(code.textContent || '')
      copy.textContent = '已复制'
      window.setTimeout(() => { copy.textContent = '复制' }, 1200)
    })
    toolbar.append(language, copy)
    pre.replaceWith(shell)
    shell.append(toolbar, pre)
  }
}

export function toolDisplayName(name: string): string {
  return toolActivityDefinition(name).title
}
