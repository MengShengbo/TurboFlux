import { describe, expect, it } from 'vitest'
import type { ComputerObservation } from '@turboflux/agent-core/contracts'
import {
  assertFreshObservation,
  keyCombinationRequiresEscalation,
  observationPoint,
  protectedComputerAppReason,
  sanitizeComputerPurpose,
} from './computerPolicy'

function observation(): ComputerObservation {
  const capturedAt = Date.now()
  return {
    frameId: 'frame-1',
    capturedAt,
    expiresAt: capturedAt + 20_000,
    displayId: '1',
    scope: 'window',
    controlMode: 'foreground-visual',
    coordinateSpace: {
      frameId: 'frame-1',
      displayId: '1',
      capturedAt,
      logicalBounds: { x: -100, y: 20, width: 800, height: 500 },
      pixelSize: { width: 1600, height: 1000 },
      scaleFactor: 2,
    },
    image: { id: 'image-1', type: 'image', path: '/tmp/image.png', mime: 'image/png', filename: 'image.png', size: 10, width: 1600, height: 1000 },
    elements: [],
    protectedRegions: [],
  }
}

describe('computer policy', () => {
  it('maps screenshot pixels to Retina and negative global coordinates', () => {
    expect(observationPoint(observation(), { x: 800, y: 500 })).toEqual({ x: 300, y: 270 })
  })

  it('rejects stale observations', () => {
    const current = observation()
    expect(assertFreshObservation(current, current.capturedAt + 19_999)).toBe(current)
    expect(() => assertFreshObservation(current, current.expiresAt + 1)).toThrow(/stale/i)
  })

  it('protects TurboFlux, terminals, settings, and password managers', () => {
    expect(protectedComputerAppReason({ pid: 42, name: 'TurboFlux' }, 42)).toMatch(/own window/i)
    expect(protectedComputerAppReason({ pid: 7, name: 'Terminal', bundleId: 'com.apple.Terminal' }, 42)).toMatch(/Terminal/)
    expect(protectedComputerAppReason({ pid: 8, name: '1Password', bundleId: 'com.1password.1password' }, 42)).toMatch(/takeover/)
    expect(protectedComputerAppReason({ pid: 10, name: '系统设置' }, 42)).toMatch(/takeover/)
    expect(protectedComputerAppReason({ pid: 11, name: 'iTerm2' }, 42)).toMatch(/takeover/)
    expect(protectedComputerAppReason({ pid: 12, name: 'Bitwarden' }, 42)).toMatch(/takeover/)
    expect(protectedComputerAppReason({ pid: 9, name: 'Pages', bundleId: 'com.apple.Pages' }, 42)).toBeUndefined()
  })

  it('escalates destructive application shortcuts', () => {
    expect(keyCombinationRequiresEscalation(['META', 'Q'])).toBe(true)
    expect(keyCombinationRequiresEscalation(['META', 'C'])).toBe(false)
  })

  it('keeps semantic activity summaries while removing implementation and secret details', () => {
    expect(sanitizeComputerPurpose('在 Keynote 中调整封面布局', '操作当前界面')).toBe('在 Keynote 中调整封面布局')
    expect(sanitizeComputerPurpose('点击 x=420 y=180', '操作当前界面')).toBe('操作当前界面')
    expect(sanitizeComputerPurpose('输入 password: hunter2', '填写当前内容')).toBe('填写当前内容')
    expect(sanitizeComputerPurpose('按 Cmd+Q', '使用键盘操作')).toBe('使用键盘操作')
  })
})
