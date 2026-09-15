import { ChevronRight, FileText, FolderOpen, Search, createElement } from 'lucide'
import type { RetrievalResult, RetrievedResource } from '@turboflux/agent-core/renderer'
import { copyContentButton, createSourceView } from './sourceView'

function resourceLines(entries: RetrievedResource[]) {
  const lines = new Map<number, { line: number; text: string; matched?: boolean }>()
  for (const entry of entries) {
    const source = entry.lines || (entry.state === 'read' && entry.line && entry.preview
      ? entry.preview.split('\n').map((text, offset) => ({ line: entry.line! + offset, text, matched: entry.state === 'matched' })) : [])
    for (const line of source) {
      const previous = lines.get(line.line)
      if (!previous || line.text.length >= previous.text.length) lines.set(line.line, { ...line, matched: line.matched || previous?.matched })
      else if (line.matched) previous.matched = true
    }
  }
  return [...lines.values()].sort((a, b) => a.line - b.line)
}

export function createRetrievalResources(resources: RetrievedResource[]): HTMLElement {
  const host = document.createElement('div')
  host.className = 'retrieval-resources'
  const files = new Map<string, RetrievedResource[]>()
  for (const resource of resources) {
    const entries = files.get(resource.path) || []
    entries.push(resource)
    files.set(resource.path, entries)
  }
  for (const [path, entries] of files) {
    const read = entries.some(entry => entry.state === 'read')
    const matched = entries.some(entry => entry.state === 'matched')
    const directory = entries[0].kind === 'directory'
    const root = document.createElement('details')
    root.className = 'retrieval-resource'
    root.dataset.resourcePath = path
    root.open = files.size <= 3 && entries.some(entry => entry.preview || entry.lines?.length)
    const header = document.createElement('summary')
    const chevron = createElement(ChevronRight, { width: 13, height: 13, 'aria-hidden': 'true' })
    chevron.classList.add('retrieval-file-chevron')
    header.append(chevron, createElement(directory ? FolderOpen : FileText, { width: 15, height: 15, 'aria-hidden': 'true' }))
    const name = document.createElement('span')
    name.className = 'retrieval-resource-name'
    const filename = document.createElement('strong')
    const parts = path.replaceAll('\\', '/').split('/')
    filename.textContent = parts.pop() || path
    const parent = document.createElement('span')
    parent.className = 'retrieval-resource-parent'
    parent.textContent = parts.join('/')
    name.append(filename, parent)
    name.title = path
    const state = document.createElement('span')
    state.className = `retrieval-resource-state${read ? ' is-read' : ''}`
    const ranges = [...new Set(entries.filter(entry => entry.state === 'read' && entry.line)
      .map(entry => `${entry.line}${entry.endLine && entry.endLine !== entry.line ? `-${entry.endLine}` : ''}`))]
    state.textContent = ranges.length
      ? `${ranges.join('、')} 行 · 已读`
      : read ? '已读' : directory ? '目录' : matched ? '匹配' : '已找到'
    header.append(name, state, copyContentButton(path, `复制路径 ${path}`))
    root.append(header)
    const body = document.createElement('div')
    body.className = 'retrieval-resource-body'
    const lines = resourceLines(entries)
    if (lines.length) body.append(createSourceView(lines, path))
    else if (entries.some(entry => entry.preview)) {
      // Historical search previews do not carry reliable context line numbers.
      const preview = document.createElement('pre')
      preview.className = 'retrieval-legacy-excerpt'
      preview.textContent = entries.map(entry => entry.preview).filter(Boolean).join('\n\n')
      body.append(preview)
    }
    else {
      const text = document.createElement('p')
      const count = entries.find(entry => entry.matchCount !== undefined)?.matchCount
      text.textContent = directory ? '本次只列出了目录路径' : count !== undefined ? `匹配 ${count} 行或文本块，尚未读取正文` : read ? '文件为空' : '尚未读取文件内容'
      body.append(text)
    }
    if (entries.some(entry => entry.textTruncated)) {
      const partial = document.createElement('p')
      partial.className = 'retrieval-partial'
      partial.textContent = '部分文本被截短'
      body.append(partial)
    }
    root.append(body)
    host.append(root)
  }
  return host
}

function searchScope(result: RetrievalResult): HTMLElement {
  const row = document.createElement('div')
  row.className = 'retrieval-query'
  row.append(createElement(result.query ? Search : FolderOpen, { width: 14, height: 14, 'aria-hidden': 'true' }))
  const text = document.createElement('span')
  const scope = result.scope && result.scope !== '.' ? result.scope : '当前工作区'
  text.textContent = result.query ? `“${result.query}”` : scope
  const meta = document.createElement('small')
  const files = new Set(result.resources.filter(resource => resource.kind === 'file').map(resource => resource.path)).size
  meta.textContent = [result.query ? scope : '', result.operation === 'read_file' ? '' : `${files} 个文件`,
    result.truncated ? result.operation === 'read_file' ? '部分读取' : result.totalIsExact === false ? '扫描未完成' : '还有结果' : '',
  ].filter(Boolean).join(' · ')
  row.append(text, meta)
  return row
}

export function createRetrievalView(result: RetrievalResult): HTMLElement {
  return createRetrievalGroupView([result])
}

export function createRetrievalGroupView(results: RetrievalResult[]): HTMLElement {
  const host = document.createElement('section')
  host.className = 'linear-tool-results'
  const queries = document.createElement('div')
  queries.className = 'retrieval-queries'
  for (const result of results) queries.append(searchScope(result))
  host.append(queries, createRetrievalResources(results.flatMap(result => result.resources)))
  if (results.length && results.every(result => !result.resources.length)) {
    const empty = document.createElement('p')
    empty.className = 'retrieval-empty'
    empty.textContent = results.some(result => result.truncated) ? '当前未找到匹配，扫描尚未覆盖全部范围' : '没有找到匹配结果'
    host.append(empty)
  }
  return host
}

export function replaceRetrievalView(previous: HTMLElement, next: HTMLElement): void {
  const openPaths = new Map(Array.from(previous.querySelectorAll<HTMLDetailsElement>('details')).map(element => [element.dataset.resourcePath, element.open]))
  const scrolls = new Map(Array.from(previous.querySelectorAll<HTMLElement>('[data-resource-path]')).map(element => [element.dataset.resourcePath, element.querySelector('.evidence-code')?.scrollTop || 0]))
  const focusedPath = document.activeElement?.closest<HTMLElement>('[data-resource-path]')?.dataset.resourcePath
  const focusedCode = document.activeElement?.classList.contains('evidence-code')
  const top = previous.querySelector('.retrieval-resources')?.scrollTop || 0
  previous.replaceWith(next)
  const list = next.querySelector('.retrieval-resources')
  if (list) list.scrollTop = top
  for (const resource of next.querySelectorAll<HTMLDetailsElement>('details')) {
    const open = openPaths.get(resource.dataset.resourcePath)
    if (open !== undefined) resource.open = open
    const code = resource.querySelector('.evidence-code')
    if (code) code.scrollTop = scrolls.get(resource.dataset.resourcePath) || 0
    if (focusedPath === resource.dataset.resourcePath) {
      const target = focusedCode ? code : resource.querySelector('summary')
      if (target instanceof HTMLElement) target.focus({ preventScroll: true })
    }
  }
}
