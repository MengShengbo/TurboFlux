import { ArrowLeft, BookOpen, Boxes, ChevronRight, FolderPlus, Plug, RefreshCw, Trash2, createElement } from 'lucide'
import type { WorkPackEntry } from '@turboflux/agent-core/workbench'

export interface LocalExtensionsViewOptions {
  entries: WorkPackEntry[]
  query: string
  selectedId?: string
  busy: boolean
  error?: string
  onQuery(query: string): void
  onSelect(id?: string): void
  onInstall(): void
  onRefresh(): void
  onUse(id: string, index?: number): void
  onToggle(id: string, enabled: boolean): void
  onUninstall(id: string): void
}

function text(tag: string, value: string, className = ''): HTMLElement {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = value
  return element
}

export function renderLocalExtensions(host: HTMLElement, options: LocalExtensionsViewOptions): void {
  const activeSearch = host.querySelector<HTMLInputElement>('#work-pack-search')
  const searchSelection = activeSearch && document.activeElement === activeSearch
    ? { start: activeSearch.selectionStart, end: activeSearch.selectionEnd }
    : undefined
  const view = document.createElement('div')
  view.className = 'local-extensions'
  const action = (label: string, icon: typeof Plug, callback: () => void, iconOnly = false, disabled = false) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = iconOnly ? 'evidence-icon-button' : 'local-extension-action'
    button.title = label
    button.setAttribute('aria-label', label)
    button.disabled = options.busy || disabled
    button.append(createElement(icon, { width: 16, height: 16, 'aria-hidden': 'true' }))
    if (!iconOnly) button.append(document.createTextNode(label))
    button.onclick = callback
    return button
  }
  const selected = options.entries.find(entry => entry.id === options.selectedId)
  const header = document.createElement('header')
  header.className = 'local-extensions-header'
  if (selected) header.append(action('返回插件列表', ArrowLeft, () => options.onSelect(), true))
  header.append(text('h3', selected?.name || '本地插件'))
  if (!selected) {
    header.append(text('span', `${options.entries.length} 项`))
    header.append(action('从本地安装', FolderPlus, options.onInstall), action('刷新插件', RefreshCw, options.onRefresh, true))
  }
  view.append(header)
  if (options.error) view.append(text('p', options.error, 'tool-command-error'))
  if (selected) {
    view.append(text('p', selected.description, 'local-extension-description'))
    const controls = document.createElement('div')
    controls.className = 'local-extension-controls'
    if (selected.supportsToggle) {
      const label = document.createElement('label')
      label.className = 'settings-switch'
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = selected.enabled
      toggle.disabled = options.busy
      toggle.setAttribute('aria-label', `启用 ${selected.name}`)
      toggle.onchange = () => options.onToggle(selected.id, toggle.checked)
      label.append(toggle, document.createElement('span'), text('b', selected.enabled ? '已启用' : '已停用'))
      controls.append(label)
    }
    if (selected.emphasis && (selected.emphases?.length || 0) <= 1) controls.append(action('挂载到对话', Plug, () => options.onUse(selected.id), false, !selected.enabled))
    if (selected.canUninstall) controls.append(action('卸载插件', Trash2, () => options.onUninstall(selected.id), true))
    view.append(controls)
    if (selected.error) view.append(text('p', selected.error, 'tool-command-error'))
    const info = document.createElement('dl')
    info.className = 'tool-result-fields'
    for (const [label, value] of [['来源', selected.sourceName], ['作者', selected.publisher], ['版本', selected.version], ['许可', selected.license || '未声明']]) info.append(text('dt', label), text('dd', value))
    view.append(info)
    if (selected.emphases && selected.emphases.length > 1) {
      const section = document.createElement('section')
      section.className = 'local-extension-section'
      section.append(text('h4', '挂载到对话'))
      selected.emphases.forEach((emphasis, index) => section.append(action(emphasis.name, Plug, () => options.onUse(selected.id, index), false, !selected.enabled)))
      view.append(section)
    }
    const permissionLabels = { 'filesystem.read': '读取文件', 'filesystem.write': '修改文件', network: '访问网络', storage: '保存插件数据' }
    for (const [title, entries] of [['包含能力', selected.capabilities], ['所需权限', selected.permissions.map(permission => permissionLabels[permission])]] as const) {
      const section = document.createElement('section')
      section.className = 'local-extension-section'
      section.append(text('h4', title))
      const list = document.createElement('ul')
      for (const entry of entries) list.append(text('li', entry))
      section.append(entries.length ? list : text('p', '无'))
      view.append(section)
    }
  } else {
    const search = document.createElement('input')
    search.type = 'search'
    search.id = 'work-pack-search'
    search.value = options.query
    search.placeholder = '搜索本地插件'
    search.setAttribute('aria-label', search.placeholder)
    search.oninput = event => { if (!(event as InputEvent).isComposing) options.onQuery(search.value) }
    search.addEventListener('compositionend', () => options.onQuery(search.value))
    view.append(search)
    const query = options.query.trim().toLocaleLowerCase()
    const entries = options.entries.filter(entry => `${entry.name} ${entry.description} ${entry.capabilities.join(' ')}`.toLocaleLowerCase().includes(query))
    const list = document.createElement('div')
    list.className = 'local-extension-list'
    for (const entry of entries) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'local-extension-row'
      row.append(createElement(entry.kind === 'bundle' ? Boxes : entry.kind === 'workflow' ? BookOpen : Plug, { width: 19, height: 19, 'aria-hidden': 'true' }))
      const copy = document.createElement('span')
      copy.append(text('strong', entry.name), text('small', entry.description))
      row.append(copy, text('small', entry.error ? '异常' : entry.enabled ? '已启用' : '已停用'), createElement(ChevronRight, { width: 14, height: 14, 'aria-hidden': 'true' }))
      row.onclick = () => options.onSelect(entry.id)
      list.append(row)
    }
    if (!entries.length) list.append(text('p', options.query ? '没有匹配的本地插件' : '尚未安装插件', 'tool-result-empty'))
    view.append(list)
  }
  host.replaceChildren(view)
  if (searchSelection) {
    const search = host.querySelector<HTMLInputElement>('#work-pack-search')
    search?.focus({ preventScroll: true })
    search?.setSelectionRange(searchSelection.start, searchSelection.end)
  }
}
