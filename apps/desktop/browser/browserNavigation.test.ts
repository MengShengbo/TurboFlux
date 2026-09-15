import { afterEach, describe, expect, it, vi } from 'vitest'
import { navigateBrowserDocument, type BrowserNavigationTarget } from './browserNavigation'

afterEach(() => vi.useRealTimers())

function targetWithPendingLoad() {
  let ready: (() => void) | undefined
  const target: BrowserNavigationTarget = {
    loadURL: vi.fn(() => new Promise<void>(() => {})),
    once: vi.fn((_event, listener) => { ready = listener }),
    removeListener: vi.fn(),
    stop: vi.fn(),
  }
  return { target, ready: () => ready?.() }
}

describe('browser navigation boundary', () => {
  it('returns when the document is ready without waiting for every subresource', async () => {
    const fixture = targetWithPendingLoad()
    const pending = navigateBrowserDocument(fixture.target, 'https://example.test')

    fixture.ready()

    await expect(pending).resolves.toBeUndefined()
    expect(fixture.target.stop).not.toHaveBeenCalled()
  })

  it('stops a document that never becomes ready', async () => {
    vi.useFakeTimers()
    const fixture = targetWithPendingLoad()
    const pending = navigateBrowserDocument(fixture.target, 'https://example.test', undefined, 1_000)
    const assertion = expect(pending).rejects.toThrow('Timed out after 1000ms')

    await vi.advanceTimersByTimeAsync(1_000)

    await assertion
    expect(fixture.target.stop).toHaveBeenCalledOnce()
  })

  it('stops immediately when the run is aborted', async () => {
    const fixture = targetWithPendingLoad()
    const controller = new AbortController()
    const pending = navigateBrowserDocument(fixture.target, 'https://example.test', controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()

    await assertion
    expect(fixture.target.stop).toHaveBeenCalledOnce()
  })
})
