import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerSystemSnapshot } from '@turboflux/agent-core/contracts'

const electronMock = vi.hoisted(() => {
  const windows: Array<{
    finishLoad?: () => void
    isDestroyed: ReturnType<typeof vi.fn>
    isVisible: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    setBounds: ReturnType<typeof vi.fn>
    setOpacity: ReturnType<typeof vi.fn>
    showInactive: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    webContents: {
      once: ReturnType<typeof vi.fn>
      executeJavaScript: ReturnType<typeof vi.fn>
    }
  }> = []
  class BrowserWindow {
    finishLoad?: () => void
    isDestroyed = vi.fn(() => false)
    isVisible = vi.fn(() => false)
    hide = vi.fn()
    setBounds = vi.fn()
    setOpacity = vi.fn()
    showInactive = vi.fn()
    destroy = vi.fn()
    setAlwaysOnTop = vi.fn()
    setFocusable = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setContentProtection = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    on = vi.fn()
    webContents = {
      once: vi.fn((_event: string, listener: () => void) => { this.finishLoad = listener }),
      executeJavaScript: vi.fn(() => Promise.resolve()),
    }

    constructor() {
      windows.push(this)
    }
  }
  return {
    BrowserWindow,
    windows,
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
      getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    },
  }
})

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/TurboFlux' },
  BrowserWindow: electronMock.BrowserWindow,
  screen: electronMock.screen,
}))

import {
  ComputerActivityOverlay,
  classifyComputerOverlayRuntimeEvent,
  computerOverlayApprovalOptions,
  computerOverlayBounds,
  computerOverlayPresentation,
} from './computerActivityOverlay'

function snapshot(update: Partial<ComputerSystemSnapshot> = {}): ComputerSystemSnapshot {
  return {
    platform: 'darwin',
    available: true,
    paused: false,
    handoffActive: false,
    sessionActive: true,
    permissions: {
      screenRecording: { kind: 'screen-recording', state: 'granted', canRequest: false },
      accessibility: { kind: 'accessibility', state: 'granted', canRequest: false },
      postEvent: { kind: 'post-event', state: 'granted', canRequest: false },
    },
    displays: [],
    ...update,
  }
}

describe('computer activity overlay', () => {
  beforeEach(() => {
    electronMock.windows.length = 0
    vi.clearAllMocks()
  })

  it('summarizes computer work without exposing implementation details', () => {
    const result = computerOverlayPresentation(snapshot({
      activity: {
        phase: 'acting',
        appName: 'Keynote',
        description: '正在调整演示文稿',
        controlMode: 'foreground-visual',
        startedAt: 1,
      },
    }))
    expect(result).toEqual(expect.objectContaining({ title: 'Keynote', detail: '正在调整演示文稿', phase: 'active' }))
  })

  it('keeps a concise waiting state between computer operations', () => {
    const result = computerOverlayPresentation(snapshot(), {
      phase: 'acting',
      appName: 'Pages',
      description: '正在整理文档',
      controlMode: 'background-semantic',
      startedAt: 1,
    })
    expect(result).toEqual(expect.objectContaining({ title: 'Pages', detail: '正在准备下一步' }))
  })

  it('puts Computer approvals and control actions on the floating panel', () => {
    const result = computerOverlayPresentation(snapshot({
      activeApp: { pid: 101, name: 'Safari', bundleId: 'com.apple.Safari', active: true },
    }), undefined, false, {
      id: 'approval-1',
      kind: 'permission',
      question: '允许 TurboFlux 在 Safari 中点击内容吗？',
      toolName: 'computer__click',
      options: ['allow-once', 'allow-run', 'deny'],
    })

    expect(result).toMatchObject({
      title: 'Safari · 需要确认',
      phase: 'waiting',
      takeControl: true,
      resumeControl: false,
      stopControl: true,
      approval: {
        id: 'approval-1',
        options: [
          { value: 'allow-once', label: '仅这次允许', tone: 'primary' },
          { value: 'allow-run', label: '本任务自动', tone: 'normal' },
          { value: 'deny', label: '拒绝', tone: 'danger' },
        ],
      },
    })
    expect(computerOverlayApprovalOptions([])).toHaveLength(2)
  })

  it('centers inside negative-coordinate display work areas', () => {
    expect(computerOverlayBounds({ x: -1512, y: 24, width: 1512, height: 958 })).toEqual({
      x: -1166,
      y: 36,
      width: 820,
      height: 66,
    })
  })

  it('keeps canonical text deltas completely outside the overlay path', () => {
    expect(classifyComputerOverlayRuntimeEvent({
      type: 'conversation-event',
      conversationId: 'conversation-1',
      event: { type: 'stream.delta' },
    }, 'conversation-1')).toEqual({
      taskFinished: false,
      action: { kind: 'none', conversationId: 'conversation-1' },
    })
  })

  it('routes one runtime snapshot to one atomic activation action', () => {
    const runtimeSnapshot = { conversation: { id: 'conversation-1' } }
    expect(classifyComputerOverlayRuntimeEvent({
      type: 'snapshot',
      snapshot: runtimeSnapshot,
    }, 'conversation-1')).toEqual({
      taskFinished: false,
      action: { kind: 'activate', conversationId: 'conversation-1', snapshot: runtimeSnapshot },
    })
  })

  it('does no repeated native work for unchanged hidden state', () => {
    const overlay = new ComputerActivityOverlay({ isFocused: () => true } as never)
    const window = electronMock.windows.at(-1)!

    overlay.sync(snapshot(), null)
    overlay.sync(snapshot(), null)

    expect(window.isVisible).toHaveBeenCalledTimes(1)
    expect(window.hide).not.toHaveBeenCalled()
    expect(window.setBounds).not.toHaveBeenCalled()
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('renders unchanged visible semantic state only once', () => {
    const overlay = new ComputerActivityOverlay({ isFocused: () => false } as never)
    const window = electronMock.windows.at(-1)!
    window.finishLoad?.()

    overlay.sync(snapshot(), null)
    overlay.sync(snapshot(), null)

    expect(window.setBounds).toHaveBeenCalledTimes(1)
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(window.showInactive).toHaveBeenCalledTimes(1)
  })
})
