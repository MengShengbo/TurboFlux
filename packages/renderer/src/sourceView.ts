import hljs from 'highlight.js/lib/common'
import { Check, Copy, createElement } from 'lucide'

export function copyContentButton(text: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'evidence-icon-button'
  button.title = title
  button.setAttribute('aria-label', title)
  button.append(createElement(Copy, { width: 14, height: 14, 'aria-hidden': 'true' }))
  button.onclick = event => {
    event.preventDefault()
    event.stopPropagation()
    void navigator.clipboard.writeText(text).then(() => {
      button.replaceChildren(createElement(Check, { width: 14, height: 14, 'aria-hidden': 'true' }))
      button.title = '已复制'
    }).catch(() => { button.title = '复制失败' })
  }
  return button
}

export function createSourceView(lines: Array<{ line: number; text: string; matched?: boolean }>, path: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'evidence-code'
  host.tabIndex = 0
  host.setAttribute('role', 'region')
  host.setAttribute('aria-label', `${path} 文件片段`)
  const extension = path.split('.').at(-1)?.toLowerCase() || ''
  const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash' } as Record<string, string>)[extension] || extension
  let previousLine: number | undefined
  for (const line of lines) {
    if (previousLine !== undefined && line.line > previousLine + 1) {
      const gap = document.createElement('div')
      gap.className = 'evidence-code-gap'
      gap.textContent = `第 ${previousLine + 1}-${line.line - 1} 行未包含在本次片段中`
      host.append(gap)
    }
    const row = document.createElement('div')
    row.className = `evidence-code-line${line.matched ? ' is-match' : ''}`
    const number = document.createElement('span')
    number.className = 'evidence-line-number'
    number.textContent = String(line.line)
    const code = document.createElement('code')
    if (hljs.getLanguage(language)) code.innerHTML = hljs.highlight(line.text, { language, ignoreIllegals: true }).value
    else code.textContent = line.text || ' '
    row.append(number, code)
    host.append(row)
    previousLine = line.line
  }
  return host
}
