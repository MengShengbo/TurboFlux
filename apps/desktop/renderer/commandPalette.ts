import type { WorkbenchCommandDefinition, WorkbenchCommandResult } from '@turboflux/agent-core/workbench'
import { presentDesktopError } from './conversationRendering'

interface CommandPaletteOptions {
  onResult(result: WorkbenchCommandResult): void | Promise<void>
  showToast(message: string): void
}

const commandGroupLabels: Record<WorkbenchCommandDefinition['group'], string> = {
  Run: '运行',
  Workspace: '工作区',
  Capabilities: '能力',
  Tools: '工具',
  Conversation: '对话',
}

export interface CommandPaletteController {
  open(): Promise<void>
  close(): void
  isOpen(): boolean
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function commandPaletteIcon(name: 'command' | 'upDown' | 'enter'): string {
  const paths: Record<typeof name, string> = {
    command: '<path d="M9 8V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    upDown: '<path d="m8 10 4-4 4 4M16 14l-4 4-4-4"/>',
    enter: '<path d="M19 6v5a3 3 0 0 1-3 3H6M9 10l-4 4 4 4"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}

export function createCommandPalette(
  app: HTMLDivElement,
  bridge: TurboFluxDesktopBridge,
  options: CommandPaletteOptions,
): CommandPaletteController {
  const overlay = document.createElement('div')
  overlay.className = 'command-palette-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.innerHTML = `
    <button class="command-palette-backdrop" aria-label="关闭命令面板"></button>
    <section class="command-palette-window" role="dialog" aria-modal="true" aria-label="命令面板">
      <div class="command-search-row"><span class="command-search-icon">${commandPaletteIcon('command')}</span><input id="command-search" placeholder="搜索命令…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="command-results" id="command-results"></div>
      <footer><span>${commandPaletteIcon('upDown')}选择</span><span>${commandPaletteIcon('enter')}执行</span></footer>
    </section>`
  app.append(overlay)

  const input = overlay.querySelector<HTMLInputElement>('#command-search')!
  const results = overlay.querySelector<HTMLDivElement>('#command-results')!
  let commands: WorkbenchCommandDefinition[] = []
  let visible: WorkbenchCommandDefinition[] = []
  let activeIndex = 0
  let loading: Promise<void> | null = null

  async function ensureCommands(): Promise<void> {
    if (commands.length > 0) return
    if (!loading) loading = bridge.listCommands().then(items => { commands = items }).finally(() => { loading = null })
    return loading
  }

  function render(): void {
    const query = input.value.trim().toLowerCase()
    visible = commands.filter(command => {
      const haystack = `${command.title} ${command.detail} ${command.group} ${command.keywords.join(' ')}`.toLowerCase()
      return !query || haystack.includes(query)
    }).slice(0, 18)
    activeIndex = Math.max(0, Math.min(activeIndex, visible.length - 1))
    if (visible.length === 0) {
      results.innerHTML = '<div class="command-empty">没有匹配的命令</div>'
      return
    }
    let previousGroup = ''
    results.innerHTML = visible.map((command, index) => {
      const group = command.group !== previousGroup ? `<div class="command-group-label">${escapeHtml(commandGroupLabels[command.group])}</div>` : ''
      previousGroup = command.group
      return `${group}<button class="command-result ${index === activeIndex ? 'active' : ''}" data-command-id="${command.id}" data-command-index="${index}">${command.slash ? `<code>${escapeHtml(command.slash)}</code>` : ''}<span><strong>${escapeHtml(command.title)}</strong><small>${escapeHtml(command.detail)}</small></span>${command.shortcut ? `<kbd>${escapeHtml(command.shortcut)}</kbd>` : `<i>${commandPaletteIcon('enter')}</i>`}</button>`
    }).join('')
    results.querySelectorAll<HTMLButtonElement>('[data-command-id]').forEach(button => {
      button.addEventListener('pointerenter', () => {
        activeIndex = Number(button.dataset.commandIndex || 0)
        render()
      })
      button.addEventListener('click', () => void execute(button.dataset.commandId || ''))
    })
    results.querySelector<HTMLElement>('.command-result.active')?.scrollIntoView({ block: 'nearest' })
  }

  async function execute(commandId: string): Promise<void> {
    const command = visible.find(item => item.id === commandId)
    if (!command) return
    close()
    try {
      const result = await bridge.executeCommand(command.id)
      if (result.message) options.showToast(result.message)
      await options.onResult(result)
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function open(): Promise<void> {
    overlay.classList.add('visible')
    overlay.setAttribute('aria-hidden', 'false')
    input.value = ''
    activeIndex = 0
    results.innerHTML = '<div class="command-empty">正在读取命令…</div>'
    try {
      await ensureCommands()
      render()
      input.focus()
    } catch (error) {
      results.innerHTML = `<div class="command-empty">${escapeHtml(presentDesktopError(error))}</div>`
    }
  }

  function close(): void {
    overlay.classList.remove('visible')
    overlay.setAttribute('aria-hidden', 'true')
  }

  input.addEventListener('input', () => {
    activeIndex = 0
    render()
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex = Math.min(visible.length - 1, activeIndex + 1)
      render()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeIndex = Math.max(0, activeIndex - 1)
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = visible[activeIndex]
      if (command) void execute(command.id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  overlay.querySelector('.command-palette-backdrop')?.addEventListener('click', close)

  return { open, close, isOpen: () => overlay.classList.contains('visible') }
}
