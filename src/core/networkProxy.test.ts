import { describe, expect, it } from 'vitest'
import { describeNetworkProxy, resolveNetworkProxy } from './networkProxy'

describe('network proxy resolution', () => {
  it('prefers TURBOFLUX_PROXY over environment and Windows settings', () => {
    const result = resolveNetworkProxy({
      TURBOFLUX_PROXY: 'http://user:secret@proxy.local:7892',
      HTTPS_PROXY: 'http://environment.local:8080',
    }, { enabled: true, server: 'windows.local:9000' })

    expect(result.source).toBe('turboflux')
    expect(result.httpsProxy).toBe('http://user:secret@proxy.local:7892/')
    expect(describeNetworkProxy(result)).toEqual({
      enabled: true,
      source: 'turboflux',
      endpoint: 'proxy.local:7892',
    })
    expect(JSON.stringify(describeNetworkProxy(result))).not.toContain('secret')
    expect(JSON.stringify(describeNetworkProxy(result))).not.toContain('user')
  })

  it('uses HTTPS_PROXY with HTTP_PROXY as a fallback', () => {
    const result = resolveNetworkProxy({ HTTPS_PROXY: '127.0.0.1:7892' })

    expect(result.source).toBe('environment')
    expect(result.httpProxy).toBe('http://127.0.0.1:7892/')
    expect(result.httpsProxy).toBe('http://127.0.0.1:7892/')
  })

  it('supports ALL_PROXY and prefers lowercase standard variables', () => {
    const result = resolveNetworkProxy({
      ALL_PROXY: 'http://all-proxy.local:7000',
      HTTPS_PROXY: 'http://uppercase.local:8000',
      https_proxy: 'http://lowercase.local:9000',
    })

    expect(result.httpProxy).toBe('http://all-proxy.local:7000/')
    expect(result.httpsProxy).toBe('http://lowercase.local:9000/')
  })

  it('parses a plain Windows proxy server', () => {
    const result = resolveNetworkProxy({}, {
      enabled: true,
      server: '127.0.0.1:7892',
      override: 'localhost;*.local',
    })

    expect(result.source).toBe('windows')
    expect(result.httpsProxy).toBe('http://127.0.0.1:7892/')
    expect(result.noProxy.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '.local']))
  })

  it('parses protocol-specific Windows proxy servers', () => {
    const result = resolveNetworkProxy({}, {
      enabled: true,
      server: 'http=127.0.0.1:8000;https=127.0.0.1:9000',
    })

    expect(result.httpProxy).toBe('http://127.0.0.1:8000/')
    expect(result.httpsProxy).toBe('http://127.0.0.1:9000/')
  })

  it('keeps NO_PROXY entries and always bypasses loopback', () => {
    const result = resolveNetworkProxy({
      HTTPS_PROXY: 'http://proxy.local:7892',
      NO_PROXY: 'api.internal.example,*.corp.local',
    })

    expect(result.noProxy.split(',')).toEqual(expect.arrayContaining([
      'localhost',
      '127.0.0.1',
      'api.internal.example',
      '.corp.local',
    ]))
  })

  it('stays direct when the Windows proxy is disabled', () => {
    const result = resolveNetworkProxy({}, { enabled: false, server: '127.0.0.1:7892' })

    expect(result.source).toBe('direct')
    expect(result.httpProxy).toBeUndefined()
    expect(result.httpsProxy).toBeUndefined()
  })
})
