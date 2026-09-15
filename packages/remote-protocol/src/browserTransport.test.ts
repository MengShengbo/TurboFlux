import { describe, expect, it } from 'vitest'
import { HttpRemoteTransport, httpEndpointFromHints, isSecureBrowserHttpEndpoint } from './browserTransport'
import type { EncryptedRemoteEnvelope, SignedPairingResponse } from './types'

const pairingResponse = {} as SignedPairingResponse
const envelope = {} as EncryptedRemoteEnvelope

describe('browser HTTP transport', () => {
  it('invokes an injected fetch function without rebinding it as an instance method', async () => {
    const calls: string[] = []
    const fetcher = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      expect(this).toBeUndefined()
      const url = String(input)
      calls.push(url)
      const data = url.endsWith('/v1/pair')
        ? { status: 'pending', requestId: 'request-1', pollToken: 'poll-token', expiresAt: Date.now() + 1_000 }
        : url.endsWith('/v1/pair/status')
          ? { status: 'approved', requestId: 'request-1', grant: {} }
          : {}
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    } as typeof fetch
    const transport = new HttpRemoteTransport('http://127.0.0.1:4180', fetcher, { pollIntervalMs: 10 })

    await transport.pair(pairingResponse)
    await transport.exchange(envelope)

    expect(calls).toEqual([
      'http://127.0.0.1:4180/v1/pair',
      'http://127.0.0.1:4180/v1/pair/status',
      'http://127.0.0.1:4180/v1/exchange',
    ])
  })

  it('rejects plain HTTP outside a loopback debugging endpoint', () => {
    expect(() => new HttpRemoteTransport('http://192.168.2.19:48173')).toThrow(/require HTTPS/u)
    expect(isSecureBrowserHttpEndpoint('http://localhost:4180')).toBe(true)
    expect(isSecureBrowserHttpEndpoint('http://127.20.30.40:4180')).toBe(true)
    expect(isSecureBrowserHttpEndpoint('https://remote.example.test')).toBe(true)
  })

  it('prefers HTTPS hints and ignores insecure LAN HTTP hints', () => {
    expect(httpEndpointFromHints([
      { kind: 'lan', value: 'http://192.168.2.19:48173' },
      { kind: 'custom', value: 'https://remote.example.test' },
      { kind: 'lan', value: 'http://127.0.0.1:48173' },
    ])).toBe('https://remote.example.test')
  })
})
