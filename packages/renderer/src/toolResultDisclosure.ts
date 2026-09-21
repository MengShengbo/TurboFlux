import { ChevronRight, createElement } from 'lucide'

const renderers = new WeakMap<HTMLDetailsElement, () => void>()

export function createToolResultDisclosure(key: string, label: string | HTMLElement, render: (body: HTMLElement) => void): HTMLDetailsElement {
  const detail = document.createElement('details')
  detail.className = 'tool-result-disclosure'
  detail.dataset.resultKey = key
  const summary = document.createElement('summary')
  summary.append(createElement(ChevronRight, { width: 13, height: 13, 'aria-hidden': 'true' }))
  const title = document.createElement('span')
  if (typeof label === 'string') { title.textContent = label; title.title = label }
  else title.append(label)
  summary.append(title)
  const body = document.createElement('div')
  body.className = 'tool-result-disclosure-body'
  body.tabIndex = 0
  body.setAttribute('role', 'region')
  body.setAttribute('aria-label', typeof label === 'string' ? label : label.textContent || '内容')
  let rendered = false
  const renderBody = () => {
    if (!detail.open || rendered) return
    rendered = true
    render(body)
  }
  renderers.set(detail, renderBody)
  detail.addEventListener('toggle', renderBody)
  detail.append(summary, body)
  return detail
}

/** Hydrate opened sections before replacing a result so its scroll range stays stable. */
export function restoreToolResultDisclosures(previous: HTMLElement, next: HTMLElement): HTMLElement | undefined {
  const key = (detail: HTMLElement) => JSON.stringify([detail.closest<HTMLElement>('.tool-result-view')?.dataset.resultCallId, detail.dataset.resultKey])
  const states = new Map(Array.from(previous.querySelectorAll<HTMLDetailsElement>('[data-result-key]'))
    .map(detail => [key(detail), detail.open]))
  const active = previous.contains(document.activeElement) ? document.activeElement : null
  const focusedDetail = active?.closest<HTMLElement>('[data-result-key]')
  const focusKey = focusedDetail ? key(focusedDetail) : undefined
  let focusTarget: HTMLElement | undefined
  const visit = (element: Element) => {
    if (element instanceof HTMLDetailsElement && element.dataset.resultKey) {
      element.open = states.get(key(element)) ?? false
      renderers.get(element)?.()
      if (focusKey === key(element)) {
        focusTarget = element.querySelector<HTMLElement>(active?.tagName === 'SUMMARY' ? 'summary' : '.tool-result-disclosure-body') || undefined
      }
    }
    for (const child of element.children) visit(child)
  }
  visit(next)
  return focusTarget
}
