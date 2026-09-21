import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { navigateBrowserDocument, waitForBrowserNavigation, type BrowserNavigationTarget } from './browserNavigation'

afterEach(() => vi.useRealTimers())
function fixture() {
  const events = new EventEmitter()
  const target = Object.assign(events, { loadURL: vi.fn(() => new Promise<void>(() => {})), stop: vi.fn() }) satisfies BrowserNavigationTarget
  return { target, ready: () => events.emit('dom-ready') }
}

describe('browser navigation boundary', () => {
  it('returns at document readiness without waiting for every subresource', async () => {
    const { target, ready } = fixture()
    const pending = navigateBrowserDocument(target, 'https://example.test')
    ready()
    await pending
    expect(target.stop).not.toHaveBeenCalled()
    expect(target.eventNames()).toEqual([])
  })

  it('stops a document that never becomes ready', async () => {
    vi.useFakeTimers()
    const { target } = fixture()
    const rejected = expect(navigateBrowserDocument(target, 'https://example.test', undefined, 1000)).rejects.toThrow('Timed out after 1000ms')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(target.stop).toHaveBeenCalledOnce()
    expect(target.eventNames()).toEqual([])
  })

  it('stops immediately on cancellation and removes all listeners', async () => {
    const { target } = fixture()
    const controller = new AbortController()
    const rejected = expect(navigateBrowserDocument(target, 'https://example.test', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(target.stop).toHaveBeenCalledOnce()
    expect(target.eventNames()).toEqual([])
  })

  it.each(['destroyed', 'render-process-gone'])('fails immediately when %s occurs', async event => {
    const { target } = fixture()
    const rejected = expect(navigateBrowserDocument(target, 'https://example.test')).rejects.toMatchObject({ code: 'navigation-failed' })
    target.emit(event)
    await rejected
    expect(target.eventNames()).toEqual([])
  })

  it('ignores child frame failures and resolves same-document main-frame history', async () => {
    const { target } = fixture()
    const pending = waitForBrowserNavigation(target, () => {})
    target.emit('did-fail-load', {}, -105, 'DNS failed', '', false)
    target.emit('did-navigate-in-page', {}, 'https://example.test/#next', true)
    await pending
    expect(target.eventNames()).toEqual([])
  })

  it('cleans up when starting navigation throws synchronously', async () => {
    const { target } = fixture()
    await expect(waitForBrowserNavigation(target, () => { throw new Error('Already closed') })).rejects.toThrow('Already closed')
    expect(target.eventNames()).toEqual([])
  })
})
