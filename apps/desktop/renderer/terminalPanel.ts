import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { terminalTheme } from './terminalTheme'
import { currentWorkbenchMode } from './workbenchMode'
import type { DesktopTerminalEvent, DesktopTerminalSession } from '../terminal/terminalTypes'
import {
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  clampTerminalPanelHeight,
  terminalPanelHeightFromKey,
  terminalPanelHeightFromPointer,
} from './terminalPanelState'

interface TerminalClient {
  session: DesktopTerminalSession
  terminal: Terminal
  fitAddon: FitAddon
  host: HTMLDivElement
  lastSeq: number
  resizeFrame: number | null
  inputQueue: Promise<void>
}

export interface DesktopTerminalPanel {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
}

const heightStorageKey = 'turboflux.terminal.panel-height:v1'

function panelIcon(name: 'plus' | 'close' | 'terminal'): string {
  const path = name === 'plus'
    ? '<path d="M12 5v14M5 12h14"/>'
    : name === 'terminal'
      ? '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.5 9 3 3-3 3M13 15h3.5"/>'
      : '<path d="m7 7 10 10M17 7 7 17"/>'
  return `<span class="icon"><svg viewBox="0 0 24 24">${path}</svg></span>`
}


function storedPanelHeight(): number {
  try {
    const value = Number(window.localStorage.getItem(heightStorageKey))
    return Number.isFinite(value) && value > 0 ? value : TERMINAL_PANEL_DEFAULT_HEIGHT
  } catch {
    return TERMINAL_PANEL_DEFAULT_HEIGHT
  }
}

export function createTerminalPanel(
  panel: HTMLElement,
  toggleButton: HTMLButtonElement,
  mainPanel: HTMLElement,
  bridge: TurboFluxDesktopBridge,
  showToast: (message: string) => void,
): DesktopTerminalPanel {
  panel.innerHTML = `
    <div class="terminal-resize-handle" id="terminal-resize-handle" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="调整终端高度" aria-keyshortcuts="ArrowUp ArrowDown Home End" title="上下拖动调整高度；双击恢复默认高度"></div>
    <header class="terminal-panel-header">
      <div class="terminal-tabs" id="terminal-tabs" role="tablist" aria-label="终端会话"></div>
      <div class="terminal-panel-actions">
        <button type="button" id="terminal-add" title="新建终端" aria-label="新建终端">${panelIcon('plus')}</button>
        <button type="button" id="terminal-hide" title="收起终端" aria-label="收起终端">${panelIcon('close')}</button>
      </div>
    </header>
    <div class="terminal-stage" id="terminal-stage">
      <div class="terminal-empty" id="terminal-empty"><strong>还没有终端</strong><span>点击右上角 + 新建一个终端</span></div>
    </div>
  `

  const resizeHandle = panel.querySelector<HTMLElement>('#terminal-resize-handle')!
  const tabs = panel.querySelector<HTMLElement>('#terminal-tabs')!
  const stage = panel.querySelector<HTMLElement>('#terminal-stage')!
  const empty = panel.querySelector<HTMLElement>('#terminal-empty')!
  const addButton = panel.querySelector<HTMLButtonElement>('#terminal-add')!
  const hideButton = panel.querySelector<HTMLButtonElement>('#terminal-hide')!
  const clients = new Map<string, TerminalClient>()
  let activeSessionId = ''
  let loaded = false
  let loadPromise: Promise<void> | null = null
  let open = false
  let panelHeight = storedPanelHeight()

  function currentHeight(): number {
    return clampTerminalPanelHeight(panelHeight, mainPanel.clientHeight)
  }

  function updateHeight(height: number, persist = true): void {
    panelHeight = clampTerminalPanelHeight(height, mainPanel.clientHeight)
    panel.style.setProperty('--terminal-panel-height', `${panelHeight}px`)
    resizeHandle.setAttribute('aria-valuemin', '160')
    resizeHandle.setAttribute('aria-valuemax', String(Math.max(160, mainPanel.clientHeight - 170)))
    resizeHandle.setAttribute('aria-valuenow', String(panelHeight))
    if (persist) {
      try {
        window.localStorage.setItem(heightStorageKey, String(panelHeight))
      } catch {
        // A blocked local storage should not disable terminal resizing.
      }
    }
    scheduleFitActive()
  }

  function updateToggleState(): void {
    toggleButton.classList.toggle('active', open)
    toggleButton.setAttribute('aria-pressed', String(open))
    toggleButton.title = open ? '收起终端' : '打开终端'
    toggleButton.setAttribute('aria-label', toggleButton.title)
    panel.classList.toggle('open', open)
    panel.setAttribute('aria-hidden', String(!open))
  }

  function scheduleFit(client: TerminalClient): void {
    if (!open || client.session.id !== activeSessionId || !client.host.isConnected) return
    if (client.resizeFrame !== null) window.cancelAnimationFrame(client.resizeFrame)
    client.resizeFrame = window.requestAnimationFrame(() => {
      client.resizeFrame = null
      if (!open || client.session.id !== activeSessionId) return
      try {
        client.fitAddon.fit()
        const { cols, rows } = client.terminal
        if (cols !== client.session.cols || rows !== client.session.rows) {
          client.session.cols = cols
          client.session.rows = rows
          void bridge.terminalResize(client.session.id, cols, rows).catch(error => showToast(error instanceof Error ? error.message : String(error)))
        }
      } catch {
        // The panel can be between layout states while its opening animation settles.
      }
    })
  }

  function scheduleFitActive(): void {
    const client = clients.get(activeSessionId)
    if (client) scheduleFit(client)
  }

  function renderTabs(): void {
    tabs.replaceChildren()
    const orderedClients = Array.from(clients.values())
    for (const [index, client] of orderedClients.entries()) {
      const displayTitle = `会话 ${index + 1}`
      const slot = document.createElement('div')
      slot.className = `terminal-tab-slot${client.session.id === activeSessionId ? ' active' : ''}${client.session.status === 'exited' ? ' exited' : ''}`
      const button = document.createElement('button')
      button.className = 'terminal-tab'
      button.type = 'button'
      button.role = 'tab'
      button.setAttribute('aria-selected', String(client.session.id === activeSessionId))
      button.title = client.session.cwd
      const terminalIcon = document.createElement('span')
      terminalIcon.className = 'terminal-tab-icon'
      terminalIcon.setAttribute('aria-hidden', 'true')
      terminalIcon.innerHTML = panelIcon('terminal')
      const label = document.createElement('span')
      label.textContent = displayTitle
      button.append(terminalIcon, label)
      button.addEventListener('click', () => activate(client.session.id))
      const close = document.createElement('button')
      close.className = 'terminal-tab-close'
      close.type = 'button'
      close.title = `关闭${displayTitle}`
      close.setAttribute('aria-label', close.title)
      close.innerHTML = panelIcon('close')
      close.addEventListener('click', event => {
        event.stopPropagation()
        void closeSession(client.session.id)
      })
      slot.append(button, close)
      tabs.append(slot)
    }
    empty.hidden = clients.size > 0
  }

  function activate(sessionId: string): void {
    if (!clients.has(sessionId)) return
    activeSessionId = sessionId
    for (const client of clients.values()) {
      const active = client.session.id === sessionId
      client.host.classList.toggle('active', active)
      client.host.setAttribute('aria-hidden', String(!active))
    }
    renderTabs()
    const client = clients.get(sessionId)!
    scheduleFit(client)
    window.setTimeout(() => scheduleFit(client), 260)
    window.requestAnimationFrame(() => client.terminal.focus())
  }

  function appendData(client: TerminalClient, seq: number, data: string): void {
    if (seq <= client.lastSeq) return
    client.lastSeq = seq
    client.terminal.write(data)
  }

  async function hydrateBuffer(client: TerminalClient): Promise<void> {
    const buffer = await bridge.terminalRead(client.session.id, client.lastSeq)
    client.session = buffer.session
    for (const chunk of buffer.chunks) appendData(client, chunk.seq, chunk.data)
    renderTabs()
  }

  function addClient(session: DesktopTerminalSession): TerminalClient {
    const existing = clients.get(session.id)
    if (existing) {
      existing.session = session
      return existing
    }
    const host = document.createElement('div')
    host.className = 'terminal-session-host'
    host.dataset.sessionId = session.id
    host.setAttribute('role', 'tabpanel')
    stage.append(host)
    const terminal = new Terminal({
      allowProposedApi: false,
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: 1.24,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
      theme: terminalTheme(currentWorkbenchMode(), document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    const client: TerminalClient = {
      session,
      terminal,
      fitAddon,
      host,
      lastSeq: 0,
      resizeFrame: null,
      inputQueue: Promise.resolve(),
    }
    clients.set(session.id, client)
    terminal.onData(data => {
      client.inputQueue = client.inputQueue
        .then(() => bridge.terminalWrite(session.id, data))
        .then(() => undefined)
        .catch(error => showToast(error instanceof Error ? error.message : String(error)))
    })
    void hydrateBuffer(client).catch(error => showToast(error instanceof Error ? error.message : String(error)))
    return client
  }

  function removeClient(sessionId: string): void {
    const client = clients.get(sessionId)
    if (!client) return
    const ids = Array.from(clients.keys())
    const removedIndex = ids.indexOf(sessionId)
    clients.delete(sessionId)
    if (client.resizeFrame !== null) window.cancelAnimationFrame(client.resizeFrame)
    client.terminal.dispose()
    client.host.remove()
    if (activeSessionId === sessionId) {
      activeSessionId = ids[removedIndex + 1] || ids[removedIndex - 1] || ''
    }
    if (activeSessionId) activate(activeSessionId)
    else renderTabs()
  }

  async function closeSession(sessionId: string): Promise<void> {
    try {
      await bridge.terminalClose(sessionId)
      removeClient(sessionId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  async function createSession(): Promise<void> {
    addButton.disabled = true
    try {
      const session = await bridge.terminalCreate()
      addClient(session)
      activate(session.id)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      addButton.disabled = false
    }
  }

  function ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve()
    if (loadPromise) return loadPromise
    loadPromise = bridge.terminalList()
      .then(sessions => {
        loaded = true
        for (const session of sessions) addClient(session)
        if (sessions[0]) activate(sessions[0].id)
      })
      .finally(() => { loadPromise = null })
    return loadPromise
  }

  function setOpen(nextOpen: boolean): void {
    if (open === nextOpen) return
    open = nextOpen
    updateToggleState()
    if (!open) return
    updateHeight(currentHeight(), false)
    void ensureLoaded().then(() => {
      if (clients.size === 0) return createSession()
      scheduleFitActive()
      window.setTimeout(scheduleFitActive, 280)
    }).catch(error => showToast(error instanceof Error ? error.message : String(error)))
  }

  function handleTerminalEvent(event: DesktopTerminalEvent): void {
    if (event.type === 'removed') {
      removeClient(event.sessionId)
      return
    }
    if (event.type === 'data') {
      const client = clients.get(event.sessionId)
      if (client) appendData(client, event.seq, event.data)
      return
    }
    const client = clients.get(event.session.id)
    if (client) {
      client.session = event.session
      renderTabs()
    }
  }

  toggleButton.addEventListener('click', () => setOpen(!open))
  addButton.addEventListener('click', () => {
    if (!open) setOpen(true)
    void ensureLoaded().then(createSession).catch(error => showToast(error instanceof Error ? error.message : String(error)))
  })
  hideButton.addEventListener('click', () => setOpen(false))
  resizeHandle.addEventListener('dblclick', () => updateHeight(TERMINAL_PANEL_DEFAULT_HEIGHT))
  resizeHandle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    updateHeight(terminalPanelHeightFromKey(currentHeight(), event.key as 'ArrowUp' | 'ArrowDown' | 'Home' | 'End', mainPanel.clientHeight))
  })
  resizeHandle.addEventListener('pointerdown', event => {
    if (!open) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = currentHeight()
    const pointerId = event.pointerId
    panel.classList.add('resizing')
    resizeHandle.setPointerCapture(pointerId)
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      updateHeight(terminalPanelHeightFromPointer(startHeight, startY, moveEvent.clientY, mainPanel.clientHeight), false)
    }
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return
      resizeHandle.removeEventListener('pointermove', move)
      resizeHandle.removeEventListener('pointerup', finish)
      resizeHandle.removeEventListener('pointercancel', finish)
      panel.classList.remove('resizing')
      updateHeight(currentHeight())
    }
    resizeHandle.addEventListener('pointermove', move)
    resizeHandle.addEventListener('pointerup', finish)
    resizeHandle.addEventListener('pointercancel', finish)
  })

  const resizeObserver = new ResizeObserver(() => {
    if (open) updateHeight(currentHeight(), false)
  })
  resizeObserver.observe(mainPanel)
  const themeObserver = new MutationObserver(() => {
    const theme = terminalTheme(currentWorkbenchMode(), document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    for (const client of clients.values()) client.terminal.options.theme = theme
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-workbench-mode'] })
  bridge.onTerminalEvent(handleTerminalEvent)
  updateHeight(panelHeight, false)
  updateToggleState()

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
  }
}
