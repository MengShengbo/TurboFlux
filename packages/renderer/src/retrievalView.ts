import { ChevronRight, FileText, FolderOpen, createElement } from 'lucide'
import type { RetrievalResult, RetrievedResource } from '@turboflux/presentation'
import { copyContentButton, createSourceView } from './sourceView'
import { restoreToolResultDisclosures } from './toolResultDisclosure'

const resourceBodyRenderers = new WeakMap<HTMLDetailsElement, () => void>()

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
    const directory = entries[0].kind === 'directory'
    const hasContent = entries.some(entry => entry.preview || entry.lines?.length)
    const root = document.createElement(hasContent ? 'details' : 'div')
    root.className = 'retrieval-resource'
    root.dataset.resourcePath = path
    const header = document.createElement(hasContent ? 'summary' : 'div')
    header.className = 'retrieval-resource-header'
    const chevron = createElement(ChevronRight, { width: 13, height: 13, 'aria-hidden': 'true' })
    chevron.classList.add('retrieval-file-chevron')
    if (!hasContent) chevron.style.visibility = 'hidden'
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
    state.className = 'retrieval-resource-state'
    const ranges = [...new Set(entries.filter(entry => entry.state === 'read' && entry.line)
      .map(entry => `${entry.line}${entry.endLine && entry.endLine !== entry.line ? `-${entry.endLine}` : ''}`))]
    state.textContent = ranges.length ? `${ranges.join('、')} 行` : ''
    state.title = state.textContent
    header.append(name, state, copyContentButton(path, `复制路径 ${path}`))
    root.append(header)
    if (root instanceof HTMLDetailsElement) {
      const body = document.createElement('div')
      body.className = 'retrieval-resource-body'
      const renderBody = () => {
        if (!root.open || body.childElementCount) return
        const lines = resourceLines(entries)
        if (lines.length) body.append(createSourceView(lines, path))
        else {
          // Historical search previews do not carry reliable context line numbers.
          const preview = document.createElement('pre')
          preview.className = 'retrieval-legacy-excerpt'
          preview.textContent = entries.map(entry => entry.preview).filter(Boolean).join('\n\n')
          body.append(preview)
        }
        if (entries.some(entry => entry.textTruncated)) {
          const partial = document.createElement('p')
          partial.className = 'retrieval-partial'
          partial.textContent = '部分文本被截短'
          body.append(partial)
        }
      }
      resourceBodyRenderers.set(root, renderBody)
      root.addEventListener('toggle', renderBody)
      root.append(body)
    }
    host.append(root)
  }
  return host
}

export function createRetrievalView(result: RetrievalResult): HTMLElement {
  return createRetrievalGroupView([result])
}

export function createRetrievalGroupView(results: RetrievalResult[]): HTMLElement {
  const host = document.createElement('section')
  host.className = 'linear-tool-results'
  host.append(createRetrievalResources(results.flatMap(result => result.resources)))
  if (results.length && results.every(result => !result.resources.length)) {
    const empty = document.createElement('p')
    empty.className = 'retrieval-empty'
    empty.textContent = results.some(result => result.truncated) ? '当前未找到匹配，扫描尚未覆盖全部范围' : '没有找到匹配结果'
    host.append(empty)
  } else if (results.some(result => result.operation !== 'read_file' && result.truncated)) {
    const partial = document.createElement('p')
    partial.className = 'retrieval-partial'
    partial.textContent = results.some(result => result.operation !== 'read_file' && result.truncated && result.totalIsExact === false)
      ? '扫描未完成' : '还有未显示的结果'
    host.append(partial)
  }
  return host
}

export function replaceRetrievalView(previous: HTMLElement, next: HTMLElement): void {
  const openPaths = new Map(Array.from(previous.querySelectorAll<HTMLDetailsElement>('details[data-resource-path]')).map(element => [element.dataset.resourcePath, element.open]))
  const active = previous.contains(document.activeElement) ? document.activeElement : null
  const focusedPath = active?.closest<HTMLElement>('[data-resource-path]')?.dataset.resourcePath
  const focusSelector = active?.classList.contains('evidence-code') ? '.evidence-code'
    : active?.classList.contains('evidence-icon-button') ? '.evidence-icon-button' : 'summary'
  const scrollHost = previous.closest<HTMLElement>('.linear-tool-body, .linear-tool-group-body, .tool-activity-body-inner')
  const top = scrollHost?.scrollTop || 0
  const detailFocus = restoreToolResultDisclosures(previous, next)
  // Restore open bodies before insertion so a result update cannot collapse the scroll range.
  for (const resource of next.querySelectorAll<HTMLDetailsElement>('details[data-resource-path]')) {
    const open = openPaths.get(resource.dataset.resourcePath)
    if (open !== undefined) resource.open = open
    resourceBodyRenderers.get(resource)?.()
  }
  previous.replaceWith(next)
  detailFocus?.focus({ preventScroll: true })
  if (focusedPath) {
    for (const resource of next.querySelectorAll<HTMLElement>('[data-resource-path]')) {
      if (focusedPath === resource.dataset.resourcePath) resource.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true })
    }
  }
  if (scrollHost) scrollHost.scrollTop = top
}
