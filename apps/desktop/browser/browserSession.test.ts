import { EventEmitter } from 'node:events'
import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { browserPartition, registerBrowserSession } from './browserSession'

function sessionFixture() {
  return Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
    webRequest: { onCompleted: vi.fn(), onErrorOccurred: vi.fn() },
  })
}
function owner(id: number) {
  return { ownsWebContents: (candidate: number) => candidate === id, handleDownload: vi.fn(), recordNetworkIssue: vi.fn() }
}

describe('browser session ownership', () => {
  it('partitions sessions by conversation without putting conversation text in the partition name', () => {
    expect(browserPartition('first')).not.toEqual(browserPartition('second'))
    expect(browserPartition('first')).toEqual(browserPartition('first'))
    expect(browserPartition('first')).not.toContain('first')
  })

  it('routes downloads to their owner and denies orphaned downloads', () => {
    const session = sessionFixture(), first = owner(1), second = owner(2)
    const releaseFirst = registerBrowserSession(session as unknown as Session, first)
    const releaseSecond = registerBrowserSession(session as unknown as Session, second)
    const event = { preventDefault: vi.fn() }, item = {}
    session.emit('will-download', event, item, { id: 2 })
    expect(second.handleDownload).toHaveBeenCalledWith(item)
    expect(first.handleDownload).not.toHaveBeenCalled()
    session.emit('will-download', event, item, undefined)
    session.emit('will-download', event, item, { id: 404 })
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    releaseFirst(); releaseSecond()
  })

  it('installs session policy once and releases observers only after the last owner leaves', () => {
    const session = sessionFixture()
    const releaseFirst = registerBrowserSession(session as unknown as Session, owner(1))
    const releaseSecond = registerBrowserSession(session as unknown as Session, owner(2))
    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce()
    releaseFirst()
    expect(session.listenerCount('will-download')).toBe(1)
    expect(session.webRequest.onCompleted).not.toHaveBeenCalledWith(null)
    releaseSecond()
    expect(session.listenerCount('will-download')).toBe(0)
    expect(session.webRequest.onCompleted).toHaveBeenLastCalledWith(null)
    expect(session.webRequest.onErrorOccurred).toHaveBeenLastCalledWith(null)
  })
})
