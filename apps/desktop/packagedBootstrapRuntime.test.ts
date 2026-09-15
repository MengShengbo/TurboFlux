import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runPackagedDesktopBootstrap } from './packagedBootstrapRuntime.mjs'

describe('packaged Desktop bootstrap', () => {
  it('loads the production Main directly outside hidden QA', async () => {
    const processTarget = new EventEmitter()
    const loadMain = vi.fn(async () => undefined)
    await runPackagedDesktopBootstrap(loadMain, {
      environment: {},
      processTarget,
      terminate: vi.fn(),
      report: vi.fn(),
    })
    expect(loadMain).toHaveBeenCalledOnce()
    expect(processTarget.eventNames()).toEqual([])
  })

  it('captures a hidden QA import failure before Electron can show an error dialog', async () => {
    const processTarget = new EventEmitter()
    const failure = new Error('main import failed')
    const report = vi.fn()
    const terminate = vi.fn()
    await runPackagedDesktopBootstrap(async () => { throw failure }, {
      environment: { TURBOFLUX_DESKTOP_QA_HIDDEN: '1' },
      processTarget,
      terminate,
      report,
    })
    expect(processTarget.listenerCount('uncaughtException')).toBe(1)
    expect(processTarget.listenerCount('unhandledRejection')).toBe(1)
    expect(report).toHaveBeenCalledWith('TurboFlux hidden QA bootstrap failure', failure)
    expect(terminate).toHaveBeenCalledWith(1)
  })

  it('reports only the first hidden QA fatal error', async () => {
    const processTarget = new EventEmitter()
    const report = vi.fn()
    const terminate = vi.fn()
    await runPackagedDesktopBootstrap(async () => undefined, {
      environment: { TURBOFLUX_DESKTOP_QA_HIDDEN: '1' },
      processTarget,
      terminate,
      report,
    })
    processTarget.emit('uncaughtException', new Error('first'))
    processTarget.emit('unhandledRejection', new Error('second'))
    expect(report).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
  })
})
