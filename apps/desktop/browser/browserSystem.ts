import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import {
  session,
  WebContentsView,
  type BrowserWindow,
  type DownloadItem,
  type OnCompletedListenerDetails,
  type OnErrorOccurredListenerDetails,
  type WebFrameMain,
} from 'electron'
import type {
  BrowserBounds,
  BrowserObservation,
  BrowserObservedElement,
  BrowserFrameSnapshot,
  BrowserActivityPhase,
  BrowserActivitySnapshot,
  BrowserDownloadSnapshot,
  BrowserErrorSnapshot,
  BrowserExecutionSnapshot,
  BrowserSystemEvent,
  BrowserSystemSnapshot,
  BrowserTabSnapshot,
  BrowserViewportMode,
} from '@turboflux/contracts'
import type { McpClient, McpLocalToolResult, McpToolCallOptions } from '@turboflux/extensions'
import { validateBrowserDestination, validateBrowserNavigation } from './browserPolicy'
import {
  normalizeBrowserKey,
  normalizeBrowserTimeout,
  redactDiagnosticUrl,
  sanitizeBrowserRef,
} from './browserTesting'
import {
  SerializedOperationCoordinator,
  assertOperationActive,
  createOperationAbortError,
  isOperationAbort,
} from '../systems/operationCoordinator'
import type { RuntimePausableSystemCapability } from '../systems/systemCapability'
import { captureBrowserViewport, type BrowserViewportCapture } from './browserCapture'
import { browserPartition, registerBrowserSession } from './browserSession'
import type { BrowserConsoleEntry, BrowserElementRefTarget, BrowserNetworkIssue, BrowserTab, BrowserTabRetention } from './browserTypes'
import { registerBrowserCapability } from './browserCapability'
import { browserTools, MAX_OBSERVED_ELEMENTS } from './browserTools'
import {
  browserFrameRefPrefix,
  interleaveBrowserFrameElements,
  isBrowserRefForEpoch,
  transientBrowserTabIds,
} from './browserFrames'
import { navigateBrowserDocument, waitForBrowserNavigation } from './browserNavigation'
import { withBrowserDebugger } from './browserDebugger'
import { browserDOMScript } from './browserDom'
import { BrowserRuntime, BrowserOperationError, browserFailure } from './browserRuntime'

const BACKGROUND_BROWSER_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }
const MAX_OBSERVED_TEXT = 10_000
const MAX_DIAGNOSTIC_ENTRIES = 120
const MAX_BROWSER_EXECUTIONS = 200
const MAX_BROWSER_DOWNLOAD_BYTES = 250 * 1024 * 1024
const MAX_OBSERVED_FRAMES = 24
const BROWSER_OPERATION_ABORT_MESSAGE = 'Browser operation aborted'

interface FrameObservationResult {
  title: string
  url: string
  text: string
  elements: BrowserObservedElement[]
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  truncated: boolean
}

interface BrowserTargetProbe {
  name: string; role: string; visible: boolean; enabled: boolean; editable: boolean; receivesEvents: boolean
  blocker?: string; href?: string; value?: string; checked: boolean; x: number; y: number; bounds: BrowserBounds
}

interface ObservedFrame {
  frame: WebFrameMain
  frameIndex: number
  snapshot: BrowserFrameSnapshot
  result?: FrameObservationResult
}

function safeFilename(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'download'
}

function sameBounds(left: BrowserBounds, right: BrowserBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function browserOperationAbortError(): Error {
  return createOperationAbortError(BROWSER_OPERATION_ABORT_MESSAGE)
}

function assertBrowserOperationActive(signal?: AbortSignal): void {
  assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
}

export class BrowserSystem implements RuntimePausableSystemCapability<BrowserSystemSnapshot> {
  private readonly partition: string
  private releaseSession: (() => void) | null = null
  private readonly tabs = new Map<string, BrowserTab>()
  private activeTabId: string | null = null
  private visible = false
  private presentationEnabled = true
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private nextTabId = 1
  private nextDownloadId = 1
  private workspacePath: string
  private storageRoot?: string
  private activity: BrowserActivitySnapshot | undefined
  private readonly executions = new Map<string, BrowserExecutionSnapshot>()
  private lastError: BrowserErrorSnapshot | undefined
  private readonly downloads = new Map<string, BrowserDownloadSnapshot>()
  private readonly activeDownloads = new Set<DownloadItem>()
  private readonly operations = new SerializedOperationCoordinator(BROWSER_OPERATION_ABORT_MESSAGE)
  private stateEmitTimer: NodeJS.Timeout | null = null
  private destroyed = false
  private readonly runtime = new BrowserRuntime()

  constructor(
    private readonly window: BrowserWindow,
    workspacePath: string,
    private readonly emit: (event: BrowserSystemEvent) => void,
    private readonly conversationId = 'default',
  ) {
    this.workspacePath = resolve(workspacePath)
    this.partition = browserPartition(conversationId)
  }

  register(client: McpClient): void {
    registerBrowserCapability(
      client,
      browserTools(),
      (toolName, args, options) => this.enqueueTool(toolName, args, options),
    )
  }

  setWorkspacePath(workspacePath: string): void {
    const nextPath = resolve(workspacePath)
    if (nextPath !== this.workspacePath) {
      for (const download of this.activeDownloads) download.cancel()
      this.workspacePath = nextPath
      for (const tab of this.tabs.values()) this.invalidateObservation(tab)
    }
  }

  setStorageRoot(storageRoot: string | undefined): void {
    this.storageRoot = storageRoot ? resolve(storageRoot) : undefined
  }

  setPresentationEnabled(enabled: boolean): void {
    if (this.presentationEnabled === enabled) return
    this.presentationEnabled = enabled
    if (!enabled) this.detachAllViews()
    else if (this.visible) this.attachActiveView()
  }

  getSnapshot(): BrowserSystemSnapshot {
    return {
      conversationId: this.conversationId,
      visible: this.visible,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map(tab => this.tabSnapshot(tab)),
      activity: this.activity ? { ...this.activity } : undefined,
      executions: [...this.executions.values()].map(execution => ({ ...execution })),
      downloads: [...this.downloads.values()].map(download => ({ ...download })),
      lastError: this.lastError ? { ...this.lastError } : undefined,
    }
  }

  async show(): Promise<BrowserSystemSnapshot> {
    this.visible = true
    if (!this.activeTabId) await this.createTab('about:blank')
    if (this.presentationEnabled) this.attachActiveView()
    this.emitState()
    return this.getSnapshot()
  }

  hide(): BrowserSystemSnapshot {
    this.visible = false
    this.detachAllViews()
    this.emitState()
    return this.getSnapshot()
  }

  setBounds(bounds: BrowserBounds): BrowserSystemSnapshot {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error('Browser bounds must be finite numbers')
    const contentBounds = this.window.getContentBounds()
    const x = Math.max(0, Math.min(contentBounds.width, Math.round(bounds.x)))
    const y = Math.max(0, Math.min(contentBounds.height, Math.round(bounds.y)))
    const nextBounds = {
      x,
      y,
      width: Math.max(0, Math.min(contentBounds.width - x, Math.round(bounds.width))),
      height: Math.max(0, Math.min(contentBounds.height - y, Math.round(bounds.height))),
    }
    nextBounds.width = Math.min(nextBounds.width, contentBounds.width - nextBounds.x)
    nextBounds.height = Math.min(nextBounds.height, contentBounds.height - nextBounds.y)
    if (sameBounds(this.bounds, nextBounds)) return this.getSnapshot()
    this.bounds = nextBounds
    this.layoutActiveView()
    return this.getSnapshot()
  }

  async createTab(address = 'about:blank', signal?: AbortSignal): Promise<BrowserSystemSnapshot> {
    this.runtime.assertActive()
    assertBrowserOperationActive(signal)
    if (this.destroyed) throw new Error('Browser system has been destroyed')
    validateBrowserNavigation(address)
    if (this.tabs.size >= 32) throw new BrowserOperationError('tab-limit', 'Browser tab limit reached (32); close unused tabs first')
    this.ensureSession()
    const previousActiveTabId = this.activeTabId
    const id = `browser-tab-${this.nextTabId++}`
    const view = this.createView()
    const tab: BrowserTab = {
      id,
      view,
      title: '新标签页',
      url: 'about:blank',
      loading: false,
      crashed: false,
      consoleEntries: [],
      networkIssues: [],
      refScope: randomUUID().replaceAll('-', ''),
      unresponsive: false,
      observationEpoch: 0,
      elementRefs: new Map(),
      retention: 'transient',
    }
    this.tabs.set(id, tab)
    this.bindTab(tab)
    this.activeTabId = id
    if (this.visible && this.presentationEnabled) this.attachActiveView()
    try { await this.navigate(address, id, signal) } catch (error) {
      if ((isOperationAbort(error) || signal?.aborted) && this.tabs.has(id)) this.removeTab(tab, previousActiveTabId || undefined)
      throw error
    }
    return this.getSnapshot()
  }

  private createView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds(BACKGROUND_BROWSER_BOUNDS)
    return view
  }

  private rebuildTabView(tab: BrowserTab) {
    this.runtime.assertActive()
    const oldView = tab.view
    const history = oldView.webContents.navigationHistory
    // Preserve URL history, not serialized POST/form state that could resubmit data.
    const entries = history.getAllEntries().map(({ url, title }) => ({ url, title }))
    const index = history.getActiveIndex()
    const bounds = oldView.getBounds()
    const replacement = this.createView()
    replacement.setBounds(bounds)
    this.detachView(oldView)
    tab.view = replacement
    tab.refScope = randomUUID().replaceAll('-', '')
    tab.crashed = false
    tab.unresponsive = false
    this.invalidateObservation(tab)
    this.bindTab(tab)
    if (this.visible && this.presentationEnabled && this.activeTabId === tab.id) this.attachActiveView()
    if (!oldView.webContents.isDestroyed()) oldView.webContents.close({ waitForBeforeUnload: false })
    return { entries, index }
  }

  activateTab(tabId: string): BrowserSystemSnapshot {
    this.requireTab(tabId)
    this.activeTabId = tabId
    if (this.visible && this.presentationEnabled) this.attachActiveView()
    this.emitState()
    return this.getSnapshot()
  }

  async closeTab(tabId?: string): Promise<BrowserSystemSnapshot> {
    const target = this.requireTab(tabId)
    this.removeTab(target)
    return this.getSnapshot()
  }

  private removeTab(target: BrowserTab, preferredActiveTabId?: string): void {
    const wasActive = target.id === this.activeTabId
    this.detachView(target.view)
    this.tabs.delete(target.id)
    this.invalidateObservation(target)
    if (!target.view.webContents.isDestroyed()) target.view.webContents.close({ waitForBeforeUnload: false })
    if (wasActive) this.activeTabId = preferredActiveTabId && this.tabs.has(preferredActiveTabId) ? preferredActiveTabId : this.tabs.keys().next().value || null
    if (!this.activeTabId) this.visible = false
    else if (this.visible && this.presentationEnabled) this.attachActiveView()
    this.emitState()
  }

  async navigate(address: string, tabId?: string, signal?: AbortSignal): Promise<BrowserSystemSnapshot> {
    const tab = this.requireTab(tabId)
    let target: URL
    try {
      target = validateBrowserNavigation(address)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.recordError({ code: 'navigation-blocked', message: reason, tabId: tab.id, recoverable: false })
      this.emit({ type: 'blocked-navigation', url: address, reason })
      throw error
    }
    this.invalidateObservation(tab)
    if (tab.crashed || tab.unresponsive) {
      const history = this.rebuildTabView(tab)
      const entries = [...history.entries.slice(0, history.index + 1), { url: target.href, title: target.href }]
      await waitForBrowserNavigation(tab.view.webContents, () => tab.view.webContents.navigationHistory.restore({ entries }), signal ?? this.runtime.signal)
    } else {
      await navigateBrowserDocument(tab.view.webContents, target.href, signal ?? this.runtime.signal)
    }
    tab.crashed = false
    tab.unresponsive = false
    this.updateTab(tab)
    this.lastError = undefined
    this.emitState()
    return this.getSnapshot()
  }

  async goBack(tabId?: string): Promise<BrowserSystemSnapshot> {
    const tab = this.requireTab(tabId)
    if (tab.view.webContents.navigationHistory.canGoBack()) {
      this.invalidateObservation(tab)
      await waitForBrowserNavigation(tab.view.webContents, () => tab.view.webContents.navigationHistory.goBack(), this.runtime.signal)
    }
    this.updateTab(tab)
    return this.getSnapshot()
  }

  async goForward(tabId?: string): Promise<BrowserSystemSnapshot> {
    const tab = this.requireTab(tabId)
    if (tab.view.webContents.navigationHistory.canGoForward()) {
      this.invalidateObservation(tab)
      await waitForBrowserNavigation(tab.view.webContents, () => tab.view.webContents.navigationHistory.goForward(), this.runtime.signal)
    }
    this.updateTab(tab)
    return this.getSnapshot()
  }

  async reload(tabId?: string): Promise<BrowserSystemSnapshot> {
    const tab = this.requireTab(tabId)
    this.invalidateObservation(tab)
    if (tab.crashed || tab.unresponsive) {
      const history = this.rebuildTabView(tab)
      if (history.entries.length) {
        await waitForBrowserNavigation(tab.view.webContents, () => tab.view.webContents.navigationHistory.restore(history), this.runtime.signal)
      } else await navigateBrowserDocument(tab.view.webContents, tab.url, this.runtime.signal)
    } else await waitForBrowserNavigation(tab.view.webContents, () => tab.view.webContents.reload(), this.runtime.signal)
    tab.crashed = false
    tab.unresponsive = false
    this.updateTab(tab)
    return this.getSnapshot()
  }

  async observe(tabId?: string, maxElements = MAX_OBSERVED_ELEMENTS): Promise<BrowserObservation> {
    const tab = this.requireTab(tabId)
    return this.retryObservation(() => this.observeOnce(tab.id, maxElements))
  }

  private async observeOnce(tabId?: string, maxElements = MAX_OBSERVED_ELEMENTS): Promise<BrowserObservation> {
    const tab = this.requireTab(tabId)
    const observationPrefix = this.nextObservationPrefix(tab)
    const cap = Math.max(1, Math.min(MAX_OBSERVED_ELEMENTS, Math.floor(maxElements)))
    const epoch = tab.observationEpoch
    const observedFrames = await this.observeFrames(tab, (frame, frameIndex) => this.evaluateDOM<FrameObservationResult>(tab, frame,
      `return dom.observe(${JSON.stringify(browserFrameRefPrefix(epoch, frameIndex, tab.refScope))}, ${cap})`))
    if (tab.observationEpoch !== epoch) throw new BrowserOperationError('page-changed', 'Page changed while observing; observe the page again')
    const selected = interleaveBrowserFrameElements(
      observedFrames.filter(frame => frame.result).map(frame => ({ frameIndex: frame.frameIndex, elements: frame.result!.elements })),
      cap,
    )
    const frameByIndex = new Map(observedFrames.map(frame => [frame.frameIndex, frame]))
    const elements = selected.map(({ frameIndex, element }) => {
      const observedFrame = frameByIndex.get(frameIndex)!
      tab.elementRefs.set(element.ref, this.frameRefTarget(observedFrame.frame, observedFrame.snapshot.isMainFrame))
      return {
        ...element,
        bounds: observedFrame.snapshot.isMainFrame ? element.bounds : undefined,
        coordinateSpace: observedFrame.snapshot.isMainFrame ? 'viewport' as const : 'frame' as const,
        frame: observedFrame.snapshot,
      }
    })
    const mainResult = observedFrames.find(frame => frame.snapshot.isMainFrame)?.result
    const text = observedFrames
      .filter(frame => frame.result?.text)
      .map(frame => frame.snapshot.isMainFrame ? frame.result!.text : `[Frame ${frame.snapshot.name || frame.snapshot.id}]\n${frame.result!.text}`)
      .join('\n\n')
    const discoveredElementCount = observedFrames.reduce((count, frame) => count + (frame.result?.elements.length || 0), 0)
    return {
      tabId: tab.id,
      observationId: observationPrefix,
      title: mainResult?.title || tab.title,
      url: mainResult?.url || tab.url,
      text: text.slice(0, MAX_OBSERVED_TEXT),
      elements,
      frames: observedFrames.map(frame => frame.snapshot),
      viewport: mainResult?.viewport || { width: tab.view.getBounds().width, height: tab.view.getBounds().height, scrollX: 0, scrollY: 0 },
      truncated: text.length > MAX_OBSERVED_TEXT || discoveredElementCount > elements.length || observedFrames.some(frame => frame.result?.truncated),
    }
  }

  async find(query: string, role?: string, maxResults = 12, tabId?: string) {
    const tab = this.requireTab(tabId)
    return this.retryObservation(() => this.findOnce(query, role, maxResults, tab.id), result => result.matches.length === 0)
  }

  private async retryObservation<T>(read: () => Promise<T>, incomplete?: (result: T) => boolean): Promise<T> {
    const deadline = Date.now() + 2_000
    for (;;) {
      this.runtime.assertActive()
      try {
        const result = await read()
        if (!incomplete?.(result) || Date.now() >= deadline) return result
      } catch (error) {
        this.runtime.assertActive()
        const retryable = error instanceof BrowserOperationError && error.code === 'page-changed'
          || /frame.*(disposed|detached)|execution context.*destroyed|document.*loading/i.test(error instanceof Error ? error.message : '')
        if (!retryable || Date.now() >= deadline) throw error
      }
      await this.runtime.delay(80)
    }
  }

  private async findOnce(query: string, role?: string, maxResults = 12, tabId?: string): Promise<{ tabId: string; observationId: string; query: string; matches: BrowserObservation['elements']; frames: BrowserFrameSnapshot[]; truncated: boolean }> {
    const tab = this.requireTab(tabId)
    const normalizedQuery = query.trim()
    if (!normalizedQuery) throw new Error('Browser find requires a query')
    const observationPrefix = this.nextObservationPrefix(tab)
    const cap = Math.max(1, Math.min(30, Math.floor(maxResults)))
    const epoch = tab.observationEpoch
    const observedFrames = await this.observeFrames(tab, (frame, frameIndex) => this.evaluateDOM<FrameObservationResult>(tab, frame,
      `return dom.observe(${JSON.stringify(browserFrameRefPrefix(epoch, frameIndex, tab.refScope))}, ${cap}, ${JSON.stringify(normalizedQuery)}, ${JSON.stringify(role || '')})`))
    if (tab.observationEpoch !== epoch) throw new BrowserOperationError('page-changed', 'Page changed while finding elements; observe the page again')
    const selected = interleaveBrowserFrameElements(
      observedFrames.filter(frame => frame.result).map(frame => ({ frameIndex: frame.frameIndex, elements: frame.result!.elements })),
      cap,
    )
    const frameByIndex = new Map(observedFrames.map(frame => [frame.frameIndex, frame]))
    const matches = selected.map(({ frameIndex, element }) => {
      const observedFrame = frameByIndex.get(frameIndex)!
      tab.elementRefs.set(element.ref, this.frameRefTarget(observedFrame.frame, observedFrame.snapshot.isMainFrame))
      return {
        ...element,
        bounds: observedFrame.snapshot.isMainFrame ? element.bounds : undefined,
        coordinateSpace: observedFrame.snapshot.isMainFrame ? 'viewport' as const : 'frame' as const,
        frame: observedFrame.snapshot,
      }
    })
    const discoveredElementCount = observedFrames.reduce((count, frame) => count + (frame.result?.elements.length || 0), 0)
    return {
      tabId: tab.id,
      observationId: observationPrefix,
      query: normalizedQuery,
      matches,
      frames: observedFrames.map(frame => frame.snapshot),
      truncated: discoveredElementCount > matches.length || observedFrames.some(frame => frame.result?.truncated),
    }
  }

  async click(ref: string, clickCount = 1, tabId?: string) {
    const tab = this.requireTab(tabId)
    const target = await this.prepareTarget(tab, ref, { pointer: true })
    const targetRef = this.requireCurrentRef(tab, ref)
    const targetFrame = this.frameSnapshot(targetRef.frame, targetRef.isMainFrame, true, 1)
    const count = clickCount === 2 ? 2 : 1
    const before = { title: tab.title, url: tab.url }
    const tabsBefore = new Set(this.tabs.keys())
    let mode: 'native' | 'dom-frame' = 'native'
    // A dispatched action is never replayed through a second backend.
    this.invalidateObservation(tab)
    if (!targetRef.isMainFrame) {
      mode = 'dom-frame'
      await this.evaluateDOM(tab, targetRef.frame, `
        const element = dom.resolve(${JSON.stringify(targetRef.ref)})
        if (!dom.probe(${JSON.stringify(targetRef.ref)}).enabled) throw new Error('Element is disabled')
        element.click()
        if (${count} === 2 && element.isConnected) {
          element.click()
          element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }))
        }
      `)
    } else {
      const point = await this.validatePoint(tab, target.x, target.y)
      const events: Array<Record<string, unknown>> = [{ type: 'mouseMoved', ...point }]
      for (let index = 1; index <= count; index++) {
        events.push({ type: 'mousePressed', button: 'left', clickCount: index, ...point },
          { type: 'mouseReleased', button: 'left', clickCount: index, ...point })
      }
      await this.dispatchMouseSequence(tab, events, async () => {
        const current = await this.evaluateDOM<BrowserTargetProbe>(tab, targetRef.frame, `return dom.probe(${JSON.stringify(targetRef.ref)})`)
        if (!current.visible || !current.enabled || !current.receivesEvents || Math.abs(current.x - target.x) > 0.5 || Math.abs(current.y - target.y) > 0.5) {
          throw new BrowserOperationError('not-actionable', 'Target changed after pointer movement; inspect the current page before clicking')
        }
      })
    }
    this.updateTab(tab)
    const opened = [...this.tabs.values()].find(candidate => !tabsBefore.has(candidate.id))
    if (opened) this.updateTab(opened)
    const followedTab = opened || tab
    const after = { title: followedTab.title, url: followedTab.url, loading: followedTab.loading }
    return {
      clicked: target.name, clickCount: count, dispatched: true, mode, frame: targetFrame,
      targetUrl: target.href, openedTab: opened ? this.tabSnapshot(opened) : undefined, before, after,
      changed: before.url !== after.url || before.title !== after.title || after.loading || Boolean(opened),
      verification: 'required', next: 'Wait for the expected response, then observe or assert it. Dispatch alone does not prove completion.',
    }
  }

  async type(ref: string, text: string, submit = false, tabId?: string): Promise<{ filled: string; submitted: boolean }> {
    const tab = this.requireTab(tabId)
    await this.prepareTarget(tab, ref, { editable: true })
    const targetRef = this.requireCurrentRef(tab, ref)
    const safeRef = targetRef.ref
    try {
      const result = await (this.evaluateDOM(tab, targetRef.frame, `
        const element = dom.resolve(${JSON.stringify(safeRef)})
        if (!element) throw new Error('Element ref is stale; observe the page again')
        if (element instanceof HTMLInputElement && element.type === 'password') throw new Error('Password fields must be filled manually')
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error('Element is not editable')
        const state = dom.probe(${JSON.stringify(safeRef)})
        if (!state.enabled || !state.editable) throw new Error('Element is disabled or not editable')
        element.focus()
        const value = ${JSON.stringify(text)}
        if (element.isContentEditable) element.textContent = value
        else {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
          if (setter) setter.call(element, value)
          else element.value = value
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        if ((element.isContentEditable ? element.textContent : element.value) !== value) throw new Error('Page did not retain the requested value; inspect before retrying')
        const form = ${submit === true} ? element.closest('form') : null
        if (form instanceof HTMLFormElement) form.requestSubmit()
        return { filled: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || element.tagName, submitted: Boolean(form) }
      `) as Promise<{ filled: string; submitted: boolean }>)
      if (submit && !result.submitted) {
        await this.press('Enter', safeRef, [], tabId)
        result.submitted = true
      }
      return result
    } finally {
      this.invalidateObservation(tab)
    }
  }

  async press(key: string, ref?: string, modifiers: string[] = [], tabId?: string): Promise<{ key: string; modifiers: string[] }> {
    const tab = this.requireTab(tabId)
    const keyCode = normalizeBrowserKey(key)
    const normalizedModifiers = [...new Set(modifiers.filter(value => ['shift', 'control', 'alt', 'meta'].includes(value)))].slice(0, 4)
    if (ref) {
      await this.prepareTarget(tab, ref)
      const target = this.requireCurrentRef(tab, ref)
      await this.evaluateDOM(tab, target.frame, `
        const element = dom.resolve(${JSON.stringify(target.ref)})
        element.focus()
        if (element.getRootNode().activeElement !== element) throw new Error('Element could not receive keyboard focus')
      `)
    }
    const keys: Record<string, [string, number]> = {
      Up: ['ArrowUp', 38], Down: ['ArrowDown', 40], Left: ['ArrowLeft', 37], Right: ['ArrowRight', 39],
      Enter: ['Enter', 13], Space: [' ', 32], Tab: ['Tab', 9], Escape: ['Escape', 27],
      Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    }
    const [nativeKey, keyNumber] = keys[keyCode]
    const modifierMask = normalizedModifiers.reduce((mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 }[modifier] || 0), 0)
    const metadata = { key: nativeKey, code: keyCode === 'Space' ? 'Space' : nativeKey, windowsVirtualKeyCode: keyNumber, modifiers: modifierMask }
    const text = modifierMask & 7 ? undefined : keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : undefined
    this.invalidateObservation(tab)
    tab.view.webContents.focus()
    await withBrowserDebugger(tab.view.webContents.debugger, this.runtime, async send => {
      let releaseAttempted = false
      try {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...metadata, ...(text ? { text, unmodifiedText: text } : {}) })
        this.runtime.assertActive()
        releaseAttempted = true
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...metadata })
      } finally {
        // Only release if keyUp was never attempted; an ambiguous keyUp is not replayed.
        if (!releaseAttempted) await this.releaseInput(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...metadata })
      }
    })
    return { key: keyCode, modifiers: normalizedModifiers }
  }

  async selectOption(ref: string, values: string[], tabId?: string): Promise<{ selected: string[]; verified: boolean }> {
    const tab = this.requireTab(tabId)
    await this.prepareTarget(tab, ref)
    const target = this.requireCurrentRef(tab, ref)
    this.invalidateObservation(tab)
    return this.evaluateDOM(tab, target.frame, `
      const element = dom.resolve(${JSON.stringify(target.ref)})
      if (!(element instanceof HTMLSelectElement)) throw new Error('Element is not a native select')
      if (!dom.probe(${JSON.stringify(target.ref)}).enabled) throw new Error('Element is disabled')
      const values = ${JSON.stringify(values)}
      if (!values.length || values.length > 20 || (!element.multiple && values.length !== 1)) throw new Error('Invalid number of select options')
      const requested = values.map(value => [...element.options].find(option => option.value === value) || [...element.options].find(option => option.text === value))
      if (requested.some(option => !option || option.disabled || option.parentElement?.disabled)) throw new Error('No matching enabled select option was found')
      for (const option of element.options) option.selected = requested.includes(option)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      const selected = [...element.selectedOptions].map(option => option.value)
      if (requested.some(option => !option.selected)) throw new Error('Page rejected the selected options; inspect before retrying')
      return { selected, verified: true }
    `)
  }

  async setChecked(ref: string, checked = true, tabId?: string): Promise<{ checked: boolean; verified: boolean }> {
    const tab = this.requireTab(tabId)
    await this.prepareTarget(tab, ref, { pointer: true })
    const target = this.requireCurrentRef(tab, ref)
    this.invalidateObservation(tab)
    return this.evaluateDOM(tab, target.frame, `
      const element = dom.resolve(${JSON.stringify(target.ref)})
      if (!(element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(element.type)) throw new Error('Element is not a checkbox or radio input')
      if (!dom.probe(${JSON.stringify(target.ref)}).enabled) throw new Error('Element is disabled')
      const checked = ${checked === true}
      if (element.type === 'radio' && !checked) throw new Error('A radio input cannot be unchecked directly; select another option')
      if (element.checked !== checked) element.click()
      if (element.checked !== checked) throw new Error('Page rejected the checked state; inspect before retrying')
      return { checked: element.checked, verified: true }
    `)
  }

  async uploadFile(ref: string, requestedPath: string, tabId?: string): Promise<{ filename: string; size: number; ref: string }> {
    const tab = this.requireTab(tabId)
    const targetRef = this.requireCurrentRef(tab, ref)
    const safeRef = targetRef.ref
    if (!targetRef.isMainFrame) throw new Error('File upload inside an iframe is not supported; use a top-page file input or manual handoff')
    const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(this.workspacePath, requestedPath)
    const [workspaceRoot, filePath] = await Promise.all([realpath(this.workspacePath), realpath(candidate)])
    const relativePath = relative(workspaceRoot, filePath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
      throw new Error('Browser uploads must use a file inside the active workspace')
    }
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('Browser upload source must be a regular file')
    if (info.size > 250 * 1024 * 1024) throw new Error('Browser upload source exceeds the 250 MB limit')

    await this.prepareTarget(tab, ref)
    this.requireCurrentRef(tab, ref)
    return withBrowserDebugger(tab.view.webContents.debugger, this.runtime, async send => {
      const handle = await send('Runtime.evaluate', {
        expression: browserDOMScript(tab.refScope, `
          const element = dom.resolve(${JSON.stringify(safeRef)})
          if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('Observed element is not a native file input')
          if (!dom.probe(${JSON.stringify(safeRef)}).enabled) throw new Error('Element is disabled')
          return element
        `),
      }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
      if (handle.exceptionDetails || !handle.result?.objectId) throw new Error('File input is stale or unavailable; observe the page again')
      try {
        this.requireCurrentRef(tab, ref)
        this.invalidateObservation(tab)
        await send('DOM.setFileInputFiles', { files: [filePath], objectId: handle.result.objectId })
        return { filename: basename(filePath), size: info.size, ref: safeRef }
      } finally {
        await this.releaseInput(tab, 'Runtime.releaseObject', { objectId: handle.result.objectId })
      }
    })
  }

  async hover(ref: string, tabId?: string): Promise<{ hovered: string; mode: 'native' | 'dom-frame' }> {
    const tab = this.requireTab(tabId)
    const probe = await this.prepareTarget(tab, ref, { pointer: true })
    const target = this.requireCurrentRef(tab, ref)
    this.invalidateObservation(tab)
    if (target.isMainFrame) {
      await this.dispatchMouseSequence(tab, [{ type: 'mouseMoved', ...await this.validatePoint(tab, probe.x, probe.y) }])
    } else {
      await this.evaluateDOM(tab, target.frame, `
        const element = dom.resolve(${JSON.stringify(target.ref)})
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }))
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }))
      `)
    }
    return { hovered: probe.name, mode: target.isMainFrame ? 'native' : 'dom-frame' }
  }

  async clickAt(x: number, y: number, tabId?: string): Promise<{ x: number; y: number }> {
    const tab = this.requireTab(tabId)
    const point = await this.validatePoint(tab, x, y)
    await this.dispatchMouseSequence(tab, [
      { type: 'mouseMoved', ...point },
      { type: 'mousePressed', button: 'left', clickCount: 1, ...point },
      { type: 'mouseReleased', button: 'left', clickCount: 1, ...point },
    ])
    this.invalidateObservation(tab)
    return point
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, tabId?: string): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    const tab = this.requireTab(tabId)
    const from = await this.validatePoint(tab, fromX, fromY)
    const to = await this.validatePoint(tab, toX, toY)
    const events: Array<Record<string, unknown>> = [
      { type: 'mouseMoved', ...from },
      { type: 'mousePressed', button: 'left', clickCount: 1, ...from },
    ]
    for (let step = 1; step <= 12; step += 1) {
      const point = {
        x: Math.round(from.x + ((to.x - from.x) * step / 12)),
        y: Math.round(from.y + ((to.y - from.y) * step / 12)),
      }
      events.push({ type: 'mouseMoved', button: 'left', buttons: 1, ...point })
    }
    events.push({ type: 'mouseReleased', button: 'left', clickCount: 1, ...to })
    await this.dispatchMouseSequence(tab, events)
    this.invalidateObservation(tab)
    return { from, to }
  }

  private async dispatchMouseSequence(tab: BrowserTab, events: Array<Record<string, unknown>>, beforePress?: () => Promise<void>): Promise<void> {
    await withBrowserDebugger(tab.view.webContents.debugger, this.runtime, async send => {
      let pressed = false
      let point: Record<string, unknown> = {}
      try {
        for (const event of events) {
          this.runtime.assertActive()
          point = { x: event.x, y: event.y }
          if (event.type === 'mousePressed') {
            await beforePress?.()
            pressed = true
          }
          if (event.type === 'mouseReleased') { this.runtime.assertActive(); pressed = false }
          await send('Input.dispatchMouseEvent', event)
          if (beforePress && event.type === 'mouseMoved') await this.runtime.delay(32)
        }
      } finally {
        if (pressed) await this.releaseInput(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      }
    })
  }

  private async releaseInput(tab: BrowserTab, method: string, params: Record<string, unknown>): Promise<void> {
    // Cleanup has its own short deadline and never replays keyDown/mouseDown.
    try { await new BrowserRuntime().call(() => tab.view.webContents.debugger.sendCommand(method, params), 500) } catch {}
  }

  async scroll(direction: string, amount = 700, tabId?: string): Promise<{ direction: string; amount: number }> {
    const tab = this.requireTab(tabId)
    const distance = Math.max(100, Math.min(3000, Math.floor(amount)))
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
    const signed = direction === 'up' || direction === 'left' ? -distance : distance
    if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isFinite(amount)) throw new Error('Invalid browser scroll direction or amount')
    await this.evaluate(tab.view.webContents.mainFrame, `window.scrollBy({ ${axis === 'x' ? 'left' : 'top'}: ${signed}, behavior: 'instant' })`)
    this.invalidateObservation(tab)
    return { direction, amount: distance }
  }

  async waitFor(condition: string, value: string | undefined, ref: string | undefined, timeoutMs: unknown, tabId?: string, signal?: AbortSignal): Promise<{ condition: string; matched: true; elapsedMs: number }> {
    const timeout = normalizeBrowserTimeout(timeoutMs)
    if (!['load', 'text', 'url', 'element'].includes(condition)) throw new Error(`Unsupported wait condition: ${condition}`)
    if ((condition === 'text' || condition === 'url') && !value) throw new Error(`${condition} wait requires value`)
    if (condition === 'element' && !ref) throw new Error('element wait requires ref')
    const startedAt = Date.now()
    const tab = this.requireTab(tabId)
    do {
      this.runtime.assertActive()
      assertBrowserOperationActive(signal)
      this.requireTab(tab.id)
      if (tab.crashed) throw new BrowserOperationError('renderer-crashed', 'Browser renderer has crashed; reload the tab')
      let matched: boolean
      if (condition === 'load') matched = await this.evaluate<boolean>(tab.view.webContents.mainFrame, `document.readyState !== 'loading'`)
      else if (condition === 'url') matched = tab.view.webContents.getURL().includes(value!)
      else if (condition === 'text') matched = await this.frameTextContains(tab, value!)
      else {
        const target = this.requireCurrentRef(tab, ref!)
        matched = await this.evaluateDOM<boolean>(tab, target.frame, `return dom.probe(${JSON.stringify(target.ref)}).visible`)
      }
      if (matched) return { condition, matched: true, elapsedMs: Date.now() - startedAt }
      await this.runtime.delay(Math.min(100, Math.max(0, timeout - (Date.now() - startedAt))))
    } while (Date.now() - startedAt < timeout)
    throw new BrowserOperationError('wait-timeout', `Timed out after ${timeout}ms waiting for browser ${condition}`)
  }

  async assertPage(condition: string, value?: string, ref?: string, tabId?: string, timeoutMs: unknown = 0, expected = true): Promise<{ passed: boolean; condition: string; expected: unknown; actual: unknown; elapsedMs: number }> {
    if (!['text_contains', 'url_contains', 'element_visible', 'element_enabled', 'element_checked', 'value_equals'].includes(condition)) throw new Error(`Unsupported browser assertion: ${condition}`)
    if ((condition === 'text_contains' || condition === 'url_contains') && !value) throw new Error(`${condition} assertion requires value`)
    if (condition === 'value_equals' && value === undefined) throw new Error('value_equals assertion requires value')
    if ((condition.startsWith('element_') || condition === 'value_equals') && !ref) throw new Error(`${condition} assertion requires ref`)
    const tab = this.requireTab(tabId)
    const timeout = Number(timeoutMs) === 0 ? 0 : normalizeBrowserTimeout(timeoutMs)
    const startedAt = Date.now()
    let actual: unknown
    let passed = false
    for (;;) {
      this.requireTab(tab.id)
      if (condition === 'url_contains') { actual = tab.view.webContents.getURL(); passed = (actual as string).includes(value!) === expected }
      else if (condition === 'text_contains') {
        const text = await this.readFrameText(tab)
        passed = text.includes(value!) === expected
        actual = text.slice(0, 2_000)
      } else {
        const target = this.requireCurrentRef(tab, ref!)
        const state = await this.evaluateDOM<BrowserTargetProbe>(tab, target.frame, `return dom.probe(${JSON.stringify(target.ref)})`)
        actual = state
        const matched = condition === 'value_equals' ? state.value === value : condition === 'element_visible' ? state.visible : condition === 'element_enabled' ? state.enabled : state.checked
        passed = matched === expected
      }
      if (passed || Date.now() - startedAt >= timeout) break
      await this.runtime.delay(Math.min(100, timeout - (Date.now() - startedAt)))
    }
    return { passed, condition, expected: { value, matches: expected }, actual, elapsedMs: Date.now() - startedAt }
  }

  async inspect(ref?: string, tabId?: string): Promise<unknown> {
    const tab = this.requireTab(tabId)
    const target = ref ? this.requireCurrentRef(tab, ref) : undefined
    const inspection = await this.evaluateDOM<Record<string, unknown>>(tab, target?.frame || tab.view.webContents.mainFrame, `return dom.inspect(${JSON.stringify(target?.ref)})`)
    return { tabId: tab.id, ...inspection, frame: target ? this.frameSnapshot(target.frame, target.isMainFrame, true, 1) : undefined,
      health: { crashed: tab.crashed, unresponsive: tab.unresponsive, loading: tab.loading }, diagnostics: this.diagnostics(false, tab.id).counts }
  }

  diagnostics(clear = false, tabId?: string): { console: BrowserConsoleEntry[]; network: BrowserNetworkIssue[]; counts: { console: number; network: number } } {
    const tab = this.requireTab(tabId)
    const result = {
      console: tab.consoleEntries.map(entry => ({ ...entry })),
      network: tab.networkIssues.map(issue => ({ ...issue })),
      counts: { console: tab.consoleEntries.length, network: tab.networkIssues.length },
    }
    if (clear) {
      tab.consoleEntries = []
      tab.networkIssues = []
    }
    return result
  }

  async screenshot(tabId?: string): Promise<{ path: string; title: string; url: string }> {
    const capture = await this.captureViewport(tabId)
    return { path: capture.path, title: capture.title, url: capture.url }
  }

  async visualObserve(tabId?: string, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const capture = await this.captureViewport(tabId, signal)
    return {
      kind: 'local_tool_result',
      content: JSON.stringify({
        tabId: capture.tabId,
        title: capture.title,
        url: capture.url,
        viewport: capture.viewport,
        instruction: 'Inspect the attached current viewport as visual evidence. Any coordinates are relative to this viewport and must be refreshed after navigation, scrolling, animation, resize, or interaction.',
      }, null, 2),
      attachments: [capture.attachment],
    }
  }

  private async captureViewport(tabId?: string, signal?: AbortSignal): Promise<BrowserViewportCapture> {
    const tab = this.requireTab(tabId)
    return captureBrowserViewport(tab, this.storageRoot ?? join(this.workspacePath, '.turboflux'), this.emit, signal, this.runtime)
  }

  pauseForRuntime(): BrowserSystemSnapshot {
    this.operations.invalidate()
    this.activity = undefined
    this.emitState()
    return this.getSnapshot()
  }

  resumeForRuntime(): BrowserSystemSnapshot {
    this.operations.invalidate()
    return this.getSnapshot()
  }

  pauseOperations(): BrowserSystemSnapshot {
    return this.pauseForRuntime()
  }

  resumeOperations(): BrowserSystemSnapshot {
    return this.resumeForRuntime()
  }

  async finishTask(): Promise<void> {
    this.operations.invalidate()
    this.activity = undefined
    await this.operations.drain()
    const transientTabIds = new Set(transientBrowserTabIds([...this.tabs.values()]))
    for (const tab of this.tabs.values()) {
      if (!transientTabIds.has(tab.id)) continue
      this.detachView(tab.view)
      this.tabs.delete(tab.id)
      tab.view.webContents.close({ waitForBeforeUnload: false })
    }
    if (!this.activeTabId || !this.tabs.has(this.activeTabId)) this.activeTabId = this.tabs.keys().next().value || null
    if (!this.activeTabId) this.visible = false
    else if (this.visible && this.presentationEnabled) this.attachActiveView()
    this.emitState()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.operations.invalidate()
    if (this.stateEmitTimer) clearTimeout(this.stateEmitTimer)
    this.stateEmitTimer = null
    for (const download of this.activeDownloads) download.cancel()
    this.activeDownloads.clear()
    this.detachAllViews()
    for (const tab of this.tabs.values()) tab.view.webContents.close({ waitForBeforeUnload: false })
    this.tabs.clear()
    this.activeTabId = null
    this.executions.clear()
    this.releaseSession?.()
    this.releaseSession = null
  }

  private ensureSession(): void {
    if (this.releaseSession) return
    const browserSession = session.fromPartition(this.partition, { cache: true })
    this.releaseSession = registerBrowserSession(browserSession, {
      ownsWebContents: webContentsId => this.ownsWebContents(webContentsId),
      handleDownload: item => this.handleDownload(item),
      recordNetworkIssue: details => this.recordNetworkIssue(details),
    })
  }

  private ownsWebContents(webContentsId: number): boolean {
    return [...this.tabs.values()].some(tab => tab.view.webContents.id === webContentsId)
  }

  private handleDownload(item: DownloadItem): void {
    this.activeDownloads.add(item)
    const filename = safeFilename(item.getFilename())
    const id = `browser-download-${this.nextDownloadId++}`
    const directory = this.storageRoot
      ? join(this.storageRoot, 'attachments', 'browser-downloads')
      : join(this.workspacePath, '.turboflux', 'browser-downloads')
    const path = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`)
    const startedAt = Date.now()
    let limitError: string | undefined
    const update = (status: BrowserDownloadSnapshot['status'], error?: string) => {
      const existing = this.downloads.get(id)
      const download: BrowserDownloadSnapshot = {
        id,
        filename,
        path: status === 'completed' ? path : undefined,
        status,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        error,
        startedAt: existing?.startedAt || startedAt,
        updatedAt: Date.now(),
      }
      this.downloads.set(id, download)
      while (this.downloads.size > 24) this.downloads.delete(this.downloads.keys().next().value as string)
      this.emit({ type: 'download', download, filename, path: download.path, status, error })
      this.emitState()
    }
    try {
      mkdirSync(directory, { recursive: true })
      item.setSavePath(path)
    } catch (error) {
      this.activeDownloads.delete(item)
      item.cancel()
      const message = error instanceof Error ? error.message : String(error)
      this.recordError({ code: 'download-failed', message, recoverable: true })
      update('failed', message)
      return
    }
    if (item.getTotalBytes() > MAX_BROWSER_DOWNLOAD_BYTES) {
      this.activeDownloads.delete(item)
      limitError = 'Browser download exceeds the 250 MB limit'
      item.cancel()
      update('failed', limitError)
      return
    }
    update('started')
    item.on('updated', () => {
      if (item.getReceivedBytes() > MAX_BROWSER_DOWNLOAD_BYTES) {
        limitError = 'Browser download exceeds the 250 MB limit'
        item.cancel()
        update('failed', limitError)
        return
      }
      update('started')
    })
    item.once('done', (_event, state) => {
      this.activeDownloads.delete(item)
      const status = limitError ? 'failed' : state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed'
      const error = limitError || (status === 'failed' ? 'Browser download failed' : undefined)
      if (error) this.recordError({ code: 'download-failed', message: error, recoverable: true })
      update(status, error)
      if (status === 'completed') {
        this.emit({ type: 'artifact-ready', path, name: filename, mime: item.getMimeType() || 'application/octet-stream', kind: 'download' })
      }
    })
  }

  private bindTab(tab: BrowserTab): void {
    const contents = tab.view.webContents
    contents.on('did-start-loading', () => {
      if (tab.view.webContents !== contents) return
      this.invalidateObservation(tab)
      tab.loading = true
      tab.consoleEntries = []
      tab.networkIssues = []
      this.emitState()
    })
    contents.on('did-stop-loading', () => {
      if (tab.view.webContents !== contents) return
      tab.loading = false; this.updateTab(tab); this.emitState() })
    contents.on('console-message', event => {
      if (tab.view.webContents !== contents) return
      this.pushBounded(tab.consoleEntries, {
        level: event.level,
        message: event.message.slice(0, 2_000),
        source: event.sourceId ? redactDiagnosticUrl(event.sourceId) : undefined,
        line: event.lineNumber || undefined,
        timestamp: Date.now(),
      })
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (tab.view.webContents !== contents) return
      if (!isMainFrame || errorCode === -3) return
      this.pushBounded(tab.networkIssues, {
        method: 'GET',
        url: redactDiagnosticUrl(url),
        resourceType: 'mainFrame',
        error: errorDescription,
        timestamp: Date.now(),
      })
      this.recordError({ code: 'load-failed', message: errorDescription, tabId: tab.id, recoverable: true })
    })
    contents.on('page-title-updated', (event, title) => {
      if (tab.view.webContents !== contents) return
      event.preventDefault(); tab.title = title || tab.title; this.emitState() })
    contents.on('did-navigate', (_event, url) => {
      if (tab.view.webContents !== contents) return
      this.invalidateObservation(tab); tab.url = url; this.emitState() })
    contents.on('did-navigate-in-page', (_event, url) => {
      if (tab.view.webContents !== contents) return
      this.invalidateObservation(tab); tab.url = url; this.emitState() })
    contents.on('did-frame-navigate', (_event, _url, _statusCode, _statusText, isMainFrame) => {
      if (tab.view.webContents !== contents) return
      if (!isMainFrame) this.invalidateObservation(tab)
    })
    contents.on('frame-created', () => { if (tab.view.webContents === contents) this.invalidateObservation(tab) })
    contents.on('will-navigate', (event, url) => {
      if (tab.view.webContents !== contents) return
      try {
        validateBrowserDestination(url)
      } catch (error) {
        event.preventDefault()
        const reason = error instanceof Error ? error.message : String(error)
        this.recordError({ code: 'navigation-blocked', message: reason, tabId: tab.id, recoverable: false })
        this.emit({ type: 'blocked-navigation', url, reason })
      }
    })
    contents.on('will-frame-navigate', event => {
      if (tab.view.webContents !== contents) return
      try { validateBrowserDestination(event.url, !event.isMainFrame) }
      catch (error) {
        event.preventDefault()
        this.emit({ type: 'blocked-navigation', url: event.url, reason: error instanceof Error ? error.message : String(error) })
      }
    })
    contents.on('will-redirect', (event, url) => {
      if (tab.view.webContents !== contents) return
      try { validateBrowserDestination(url) }
      catch (error) {
        event.preventDefault()
        this.emit({ type: 'blocked-navigation', url, reason: error instanceof Error ? error.message : String(error) })
      }
    })
    contents.on('unresponsive', () => {
      if (tab.view.webContents !== contents) return
      tab.unresponsive = true; this.emitState() })
    contents.on('responsive', () => {
      if (tab.view.webContents !== contents) return
      tab.unresponsive = false; this.emitState() })
    contents.on('destroyed', () => {
      if (this.destroyed || tab.view.webContents !== contents) return
      this.invalidateObservation(tab)
      this.tabs.delete(tab.id)
      if (this.activeTabId === tab.id) this.activeTabId = this.tabs.keys().next().value || null
      if (!this.activeTabId) this.visible = false
      else if (this.visible && this.presentationEnabled) this.attachActiveView()
      this.emitState()
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('render-process-gone', () => {
      if (tab.view.webContents !== contents) return
      this.invalidateObservation(tab)
      tab.unresponsive = false
      tab.crashed = true
      tab.loading = false
      this.recordError({ code: 'renderer-crashed', message: '浏览器页面进程已停止，可以重新加载恢复', tabId: tab.id, recoverable: true })
    })
    contents.setWindowOpenHandler(details => {
      if (tab.view.webContents !== contents) return { action: 'deny' }
      try {
        validateBrowserDestination(details.url)
        void this.createTab(details.url).catch(error => {
          if (!this.destroyed) this.recordError({ code: 'load-failed', message: error instanceof Error ? error.message : String(error), recoverable: true })
        })
      } catch (error) {
        this.emit({ type: 'blocked-navigation', url: details.url, reason: error instanceof Error ? error.message : String(error) })
      }
      return { action: 'deny' }
    })
  }

  private updateTab(tab: BrowserTab): void {
    if (tab.view.webContents.isDestroyed()) return
    tab.title = tab.view.webContents.getTitle() || tab.title
    tab.url = tab.view.webContents.getURL() || tab.url
  }

  private currentFrames(tab: BrowserTab): WebFrameMain[] {
    const mainFrame = tab.view.webContents.mainFrame
    try {
      return mainFrame.framesInSubtree
        .filter(frame => this.isFrameAvailable(frame))
        .slice(0, MAX_OBSERVED_FRAMES)
    } catch {
      return mainFrame.isDestroyed() ? [] : [mainFrame]
    }
  }

  private async observeFrames(
    tab: BrowserTab,
    evaluate: (frame: WebFrameMain, frameIndex: number) => Promise<FrameObservationResult>,
  ): Promise<ObservedFrame[]> {
    const mainFrame = tab.view.webContents.mainFrame
    return Promise.all(this.currentFrames(tab).map(async (frame, frameIndex) => {
      const isMainFrame = frame === mainFrame || frame.parent === null
      try {
        const result = await evaluate(frame, frameIndex)
        return {
          frame,
          frameIndex,
          snapshot: this.frameSnapshot(frame, isMainFrame, true, result.elements.length),
          result,
        }
      } catch (error) {
        this.runtime.assertActive()
        if (isMainFrame) throw error
        return {
          frame,
          frameIndex,
          snapshot: this.frameSnapshot(frame, isMainFrame, false, 0),
        }
      }
    }))
  }

  private frameSnapshot(
    frame: WebFrameMain,
    isMainFrame: boolean,
    available: boolean,
    elementCount: number,
  ): BrowserFrameSnapshot {
    return {
      id: `frame-${frame.frameTreeNodeId}`,
      name: frame.name || undefined,
      url: frame.url || 'about:blank',
      isMainFrame,
      available,
      elementCount,
    }
  }

  private frameRefTarget(frame: WebFrameMain, isMainFrame: boolean): BrowserElementRefTarget {
    return {
      frame,
      frameTreeNodeId: frame.frameTreeNodeId,
      processId: frame.processId,
      routingId: frame.routingId,
      isMainFrame,
    }
  }

  private async frameTextContains(tab: BrowserTab, value: string): Promise<boolean> {
    return (await this.readFrameText(tab)).includes(value)
  }

  private async readFrameText(tab: BrowserTab): Promise<string> {
    const frames = this.currentFrames(tab)
    const values = await Promise.all(frames.map(async (frame, index) => {
      try { return await this.evaluateDOM<string>(tab, frame, 'return dom.text()') }
      catch (error) { this.runtime.assertActive(); if (index === 0) throw error; return '' }
    }))
    return values.join('\n\n').slice(0, MAX_OBSERVED_TEXT)
  }

  private isFrameAvailable(frame: WebFrameMain): boolean {
    return !frame.isDestroyed() && !frame.detached
  }

  private evaluate<T>(frame: WebFrameMain, script: string): Promise<T> {
    return this.runtime.call(() => {
      if (!this.isFrameAvailable(frame)) throw new BrowserOperationError('stale-reference', 'Page frame is detached; observe the page again')
      return frame.executeJavaScript(script, true) as Promise<T>
    })
  }

  private evaluateDOM<T>(tab: BrowserTab, frame: WebFrameMain, body: string): Promise<T> {
    return this.evaluate(frame, browserDOMScript(tab.refScope, body))
  }

  private async prepareTarget(tab: BrowserTab, ref: string, options: { pointer?: boolean; editable?: boolean } = {}): Promise<BrowserTargetProbe> {
    const deadline = Date.now() + 2_000
    let previous: BrowserTargetProbe | undefined
    let reason = 'Element is not actionable'
    for (;;) {
      const target = this.requireCurrentRef(tab, ref)
      const probe = await this.evaluateDOM<BrowserTargetProbe>(tab, target.frame, `return dom.probe(${JSON.stringify(target.ref)}, ${!previous})`)
      const stable = previous && ['x', 'y', 'width', 'height'].every(key => Math.abs(probe.bounds[key as keyof BrowserBounds] - previous!.bounds[key as keyof BrowserBounds]) <= 0.5)
      reason = !probe.visible ? 'Element is not visible' : !probe.enabled ? 'Element is disabled'
        : options.editable && !probe.editable ? 'Element is not editable (password and readonly fields cannot be filled)'
          : options.pointer && !probe.receivesEvents ? `Element is obscured or outside the viewport${probe.blocker ? ` by ${probe.blocker}` : ''}`
            : options.pointer && !stable ? 'Element is moving' : ''
      if (!reason) return probe
      previous = probe
      if (Date.now() >= deadline) break
      await this.runtime.delay(80)
    }
    throw new BrowserOperationError('not-actionable', reason, 'Use inspect or visual_observe to check visibility, overlays and state. Wait for the page to settle, then find the target again.')
  }

  private requireTab(tabId?: string): BrowserTab {
    this.runtime.assertActive()
    if (this.destroyed) throw new Error('Browser system has been destroyed')
    const id = tabId || this.activeTabId
    const tab = id ? this.tabs.get(id) : undefined
    if (!tab || tab.view.webContents.isDestroyed()) throw new BrowserOperationError('tab-closed', 'Browser tab not found or closed', 'Call tabs and select an existing tab, or open a new one.')
    return tab
  }

  private nextObservationPrefix(tab: BrowserTab): string {
    this.invalidateObservation(tab)
    return `o${tab.observationEpoch.toString(36)}-${tab.refScope}`
  }

  private invalidateObservation(tab: BrowserTab): void {
    tab.observationEpoch += 1
    tab.elementRefs.clear()
  }

  private requireCurrentRef(tab: BrowserTab, ref: string): BrowserElementRefTarget & { ref: string } {
    this.runtime.assertActive()
    const safeRef = sanitizeBrowserRef(ref)
    if (!isBrowserRefForEpoch(safeRef, tab.observationEpoch, tab.refScope)) {
      throw new Error('Element ref is stale; observe the page again')
    }
    const target = tab.elementRefs.get(safeRef)
    if (!target || !this.isFrameAvailable(target.frame)
      || target.frame.frameTreeNodeId !== target.frameTreeNodeId
      || target.frame.processId !== target.processId
      || target.frame.routingId !== target.routingId) {
      tab.elementRefs.delete(safeRef)
      throw new Error('Element ref is stale; observe the page again')
    }
    return { ref: safeRef, ...target }
  }

  private async validatePoint(tab: BrowserTab, x: number, y: number): Promise<{ x: number; y: number }> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Browser coordinates must be finite numbers')
    const bounds = await this.evaluate<{ width: number; height: number }>(tab.view.webContents.mainFrame, '({ width: innerWidth, height: innerHeight })')
    if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Browser surface is not ready for coordinate input')
    const point = { x: Math.round(x), y: Math.round(y) }
    if (point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height) {
      throw new Error(`Browser coordinates are outside the ${bounds.width}x${bounds.height} viewport`)
    }
    return point
  }

  private recordNetworkIssue(details: OnCompletedListenerDetails | OnErrorOccurredListenerDetails): void {
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === details.webContentsId)
    if (!tab) return
    this.pushBounded(tab.networkIssues, {
      method: details.method,
      url: redactDiagnosticUrl(details.url),
      resourceType: details.resourceType,
      status: 'statusCode' in details ? details.statusCode : undefined,
      error: details.error || undefined,
      timestamp: Date.now(),
    })
  }

  private pushBounded<T>(target: T[], value: T): void {
    target.push(value)
    if (target.length > MAX_DIAGNOSTIC_ENTRIES) target.splice(0, target.length - MAX_DIAGNOSTIC_ENTRIES)
  }

  private tabSnapshot(tab: BrowserTab): BrowserTabSnapshot {
    const history = tab.view.webContents.navigationHistory
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      canGoBack: !tab.view.webContents.isDestroyed() && history.canGoBack(),
      canGoForward: !tab.view.webContents.isDestroyed() && history.canGoForward(),
      crashed: tab.crashed || undefined,
      unresponsive: tab.unresponsive || undefined,
      retention: tab.retention,
    }
  }

  private activeTabToolResult(tabId = this.activeTabId): { activeTabId: string | null; tab?: BrowserTabSnapshot; tabCount: number } {
    const tab = tabId ? this.tabs.get(tabId) : undefined
    return {
      activeTabId: this.activeTabId,
      tab: tab ? this.tabSnapshot(tab) : undefined,
      tabCount: this.tabs.size,
    }
  }

  private tabsToolResult(): { activeTabId: string | null; tabs: BrowserTabSnapshot[]; tabCount: number } {
    const tabs = [...this.tabs.values()].map(tab => this.tabSnapshot(tab))
    return { activeTabId: this.activeTabId, tabs, tabCount: tabs.length }
  }

  private requestLayout(mode: BrowserViewportMode): { mode: BrowserViewportMode; description: string } {
    this.emit({ type: 'layout-request', mode })
    return {
      mode,
      description: mode === 'landscape'
        ? 'Browser drawer expanded to landscape layout'
        : 'Browser drawer restored to portrait layout',
    }
  }

  private capabilityReport() {
    return {
      apiVersion: 3,
      backend: { id: 'electron-iab', type: 'iab', conversationIsolatedSession: true },
      semantic: { observe: true, find: true, shortLivedRefs: true, shadowDom: 'open-only', labels: true, nodeIdentity: true },
      frames: { observe: true, find: true, semanticActions: true, nativeCoordinates: false, fileUpload: false },
      coordinates: { click: true, drag: true, visualObservation: true, scope: 'top-viewport' },
      files: { workspaceUpload: true, workspaceDownload: true, maximumBytes: MAX_BROWSER_DOWNLOAD_BYTES },
      diagnostics: { console: true, networkFailures: true, inspect: true, computedStyles: true },
      reliability: { commandTimeoutMs: 5000, toolTimeoutMs: 60000, cancellable: true, actionabilityChecks: true, automaticActionReplay: false, retryingAssertions: true },
      lifecycle: { deliverable: true, handoff: true, transientCleanup: true },
      authentication: { secureBroker: false, passwordEntry: 'manual-only' },
      externalTabs: { discover: false, claim: false },
      layout: { portrait: true, landscape: true, default: 'portrait' },
    } as const
  }

  private markTab(retention: Exclude<BrowserTabRetention, 'transient'>, tabId?: string): { tabId: string; retention: BrowserTabRetention; tab: BrowserTabSnapshot } {
    const tab = this.requireTab(tabId)
    tab.retention = retention
    this.emitState()
    return { tabId: tab.id, retention: tab.retention, tab: this.tabSnapshot(tab) }
  }

  private attachActiveView(): void {
    if (!this.visible || !this.presentationEnabled || !this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    for (const candidate of this.tabs.values()) {
      if (candidate.id !== tab.id) this.detachView(candidate.view)
    }
    if (!this.window.contentView.children.includes(tab.view)) this.window.contentView.addChildView(tab.view)
    this.layoutActiveView()
  }

  private layoutActiveView(): void {
    if (!this.visible || !this.presentationEnabled || !this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    if (this.bounds.width < 2 || this.bounds.height < 2) {
      tab.view.setVisible(false)
      return
    }
    if (!sameBounds(tab.view.getBounds(), this.bounds)) tab.view.setBounds(this.bounds)
    tab.view.setVisible(true)
  }

  private detachAllViews(): void {
    for (const tab of this.tabs.values()) this.detachView(tab.view)
  }

  private detachView(view: WebContentsView): void {
    try {
      view.setVisible(false)
      this.window.contentView.removeChildView(view)
    } catch {}
  }

  private emitState(): void {
    if (this.destroyed || this.stateEmitTimer) return
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null
      if (!this.destroyed) this.emit({ type: 'state', snapshot: this.getSnapshot() })
    }, 16)
  }

  private recordError(input: Omit<BrowserErrorSnapshot, 'occurredAt'>): void {
    this.lastError = { ...input, occurredAt: Date.now() }
    this.emitState()
  }

  private async withActivity<T>(phase: BrowserActivityPhase, operation: string, tabId: string | undefined, description: string, work: () => Promise<T>, options?: McpToolCallOptions): Promise<T> {
    const startedAt = Date.now()
    const executionContext = options?.execution
    if (executionContext?.conversationId && executionContext.conversationId !== this.conversationId) {
      throw new Error(`Browser execution conversation mismatch: ${executionContext.conversationId}`)
    }
    const activity: BrowserActivitySnapshot = {
      phase,
      operation,
      tabId,
      runId: executionContext?.runId,
      toolCallId: executionContext?.toolCallId,
      itemId: executionContext?.itemId,
      description,
      startedAt,
    }
    const execution = executionContext ? {
      conversationId: this.conversationId,
      runId: executionContext.runId,
      toolCallId: executionContext.toolCallId,
      itemId: executionContext.itemId,
      operation,
      phase,
      status: 'running' as const,
      tabId,
      startedAt,
      updatedAt: startedAt,
    } satisfies BrowserExecutionSnapshot : undefined
    if (execution) {
      this.executions.delete(execution.toolCallId)
      this.executions.set(execution.toolCallId, execution)
      while (this.executions.size > MAX_BROWSER_EXECUTIONS) {
        const oldest = this.executions.keys().next().value
        if (!oldest) break
        this.executions.delete(oldest)
      }
    }
    this.visible = true
    if (this.presentationEnabled && this.activeTabId) this.attachActiveView()
    this.activity = activity
    this.lastError = undefined
    this.emitState()
    try {
      const result = await work()
      assertBrowserOperationActive(options?.signal)
      this.finishExecution(execution, (result as { isError?: boolean })?.isError ? 'failed' : 'completed', result)
      return result
    } catch (error) {
      const cancelled = isOperationAbort(error) || Boolean(options?.signal?.aborted && !(options.signal.reason instanceof BrowserOperationError))
      this.finishExecution(execution, cancelled ? 'cancelled' : 'failed')
      if (cancelled) throw browserOperationAbortError()
      if (error instanceof BrowserOperationError && ['command-timeout', 'operation-timeout'].includes(error.code)) {
        const stalled = this.tabs.get(tabId || this.activeTabId || '')
        if (stalled) { stalled.unresponsive = true; this.invalidateObservation(stalled) }
      }
      const lastError = this.lastError as BrowserErrorSnapshot | undefined
      if (!lastError || lastError.occurredAt < activity.startedAt) {
        this.recordError({ code: 'operation-failed', message: error instanceof Error ? error.message : String(error), tabId, recoverable: true })
      }
      throw error
    } finally {
      if (this.activity === activity) {
        this.activity = undefined
        this.emitState()
      }
    }
  }

  private finishExecution(execution: BrowserExecutionSnapshot | undefined, status: BrowserExecutionSnapshot['status'], result?: unknown): void {
    if (!execution) return
    const resultTabId = result && typeof result === 'object' && typeof (result as { tabId?: unknown }).tabId === 'string'
      ? (result as { tabId: string }).tabId
      : undefined
    const tabId = resultTabId || execution.tabId || this.activeTabId || undefined
    const tab = tabId ? this.tabs.get(tabId) : undefined
    execution.status = status
    execution.tabId = tabId
    execution.title = tab?.title
    execution.url = tab?.url
    execution.updatedAt = Date.now()
    this.emitState()
  }

  private enqueueTool<T>(toolName: string, args: Record<string, unknown>, options?: McpToolCallOptions): Promise<T> {
    const requestedTabId = typeof args.tab_id === 'string' ? args.tab_id : this.activeTabId || undefined
    const stopLoading = () => {
      const tab = requestedTabId ? this.tabs.get(requestedTabId) : undefined
      if (tab && !tab.view.webContents.isDestroyed() && tab.view.webContents.isLoading()) tab.view.webContents.stop()
    }
    const boundArgs = requestedTabId && !args.tab_id && !['open', 'tabs', 'capabilities', 'set_layout'].includes(toolName) ? { ...args, tab_id: requestedTabId } : args
    return this.operations.enqueue(async signal => {
      const result = await this.runtime.run(signal, () => this.handleTool(toolName, boundArgs, this.runtime.signal, options))
      return result as T
    }, { externalSignal: options?.signal, onAbort: stopLoading }).catch(error => {
      if (isOperationAbort(error) || options?.signal?.aborted) throw error
      return { kind: 'local_tool_result', isError: true, content: JSON.stringify({ error: browserFailure(error, toolName, requestedTabId) }) } as T
    })
  }

  private async handleTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal, executionOptions?: McpToolCallOptions): Promise<unknown> {
    assertBrowserOperationActive(signal)
    if (toolName === 'capabilities') return this.capabilityReport()
    if (!this.activeTabId && !['capabilities', 'open', 'tabs', 'close', 'set_layout', 'mark_deliverable', 'mark_handoff'].includes(toolName)) await this.createTab('about:blank', signal)
    const tabId = typeof args.tab_id === 'string' ? args.tab_id : this.activeTabId || undefined
    if (tabId && toolName !== 'close' && this.tabs.has(tabId) && this.activeTabId !== tabId) this.activateTab(tabId)
    const phase: BrowserActivityPhase = ['open'].includes(toolName) ? 'opening' : ['capabilities', 'observe', 'find', 'inspect', 'diagnostics', 'assert', 'tabs'].includes(toolName) ? 'observing' : ['screenshot', 'visual_observe'].includes(toolName) ? 'capturing' : ['navigate', 'back', 'forward', 'reload', 'activate'].includes(toolName) ? 'navigating' : 'acting'
    return this.withActivity(phase, toolName, tabId, `执行浏览器操作：${toolName}`, async () => {
      switch (toolName) {
      case 'capabilities': return this.capabilityReport()
      case 'open': {
        await this.createTab(String(args.url || ''), signal)
        return this.activeTabToolResult()
      }
      case 'tabs': return this.tabsToolResult()
      case 'activate': {
        const targetId = String(args.tab_id || '')
        this.activateTab(targetId)
        return this.activeTabToolResult(targetId)
      }
      case 'navigate': {
        await this.navigate(String(args.url || ''), args.tab_id as string | undefined, signal)
        return this.activeTabToolResult(args.tab_id as string | undefined)
      }
      case 'observe': return this.observe(args.tab_id as string | undefined, Number(args.max_elements || MAX_OBSERVED_ELEMENTS))
      case 'find': return this.find(String(args.query || ''), typeof args.role === 'string' ? args.role : undefined, Number(args.max_results || 12), args.tab_id as string | undefined)
      case 'click': return this.click(String(args.ref || ''), Number(args.click_count || 1), args.tab_id as string | undefined)
      case 'type': return this.type(String(args.ref || ''), String(args.text || ''), args.submit === true, args.tab_id as string | undefined)
      case 'press': return this.press(
        String(args.key || ''),
        typeof args.ref === 'string' ? args.ref : undefined,
        Array.isArray(args.modifiers) ? args.modifiers.map(String) : [],
        args.tab_id as string | undefined,
      )
      case 'select_option': return this.selectOption(
        String(args.ref || ''),
        Array.isArray(args.values) ? args.values.map(String) : [],
        args.tab_id as string | undefined,
      )
      case 'set_checked': return this.setChecked(String(args.ref || ''), args.checked !== false, args.tab_id as string | undefined)
      case 'upload_file': return this.uploadFile(String(args.ref || ''), String(args.path || ''), args.tab_id as string | undefined)
      case 'hover': return this.hover(String(args.ref || ''), args.tab_id as string | undefined)
      case 'click_at': return this.clickAt(Number(args.x), Number(args.y), args.tab_id as string | undefined)
      case 'drag': return this.drag(Number(args.from_x), Number(args.from_y), Number(args.to_x), Number(args.to_y), args.tab_id as string | undefined)
      case 'scroll': return this.scroll(String(args.direction || 'down'), Number(args.amount || 700), args.tab_id as string | undefined)
      case 'wait': return this.waitFor(
        String(args.condition || ''),
        typeof args.value === 'string' ? args.value : undefined,
        typeof args.ref === 'string' ? args.ref : undefined,
        args.timeout_ms,
        args.tab_id as string | undefined,
        signal,
      )
      case 'assert': {
        const result = await this.assertPage(
          String(args.condition || ''),
          typeof args.value === 'string' ? args.value : undefined,
          typeof args.ref === 'string' ? args.ref : undefined,
          args.tab_id as string | undefined,
          args.timeout_ms ?? 2_000,
          args.expected !== false,
        )
        return { kind: 'local_tool_result', isError: !result.passed, content: JSON.stringify(result) } satisfies McpLocalToolResult
      }
      case 'inspect': return this.inspect(typeof args.ref === 'string' ? args.ref : undefined, args.tab_id as string | undefined)
      case 'diagnostics': return this.diagnostics(args.clear === true, args.tab_id as string | undefined)
      case 'back': return this.goBack(args.tab_id as string | undefined)
      case 'forward': return this.goForward(args.tab_id as string | undefined)
      case 'reload': return this.reload(args.tab_id as string | undefined)
      case 'screenshot': {
        const capture = await this.captureViewport(args.tab_id as string | undefined, signal)
        return { kind: 'local_tool_result', content: JSON.stringify({ tabId: capture.tabId, title: capture.title, url: capture.url, path: capture.path }, null, 2), attachments: [capture.attachment] } satisfies McpLocalToolResult
      }
      case 'visual_observe': return this.visualObserve(args.tab_id as string | undefined, signal)
      case 'set_layout': return this.requestLayout(args.mode === 'landscape' ? 'landscape' : 'portrait')
      case 'mark_deliverable': return this.markTab('deliverable', args.tab_id as string | undefined)
      case 'mark_handoff': return this.markTab('handoff', args.tab_id as string | undefined)
      case 'close': return this.closeTab(args.tab_id as string | undefined)
      default: throw new Error(`Unknown browser tool: ${toolName}`)
      }
    }, { ...executionOptions, signal })
  }
}
