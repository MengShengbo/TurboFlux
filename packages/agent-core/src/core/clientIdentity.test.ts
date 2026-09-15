import { describe, expect, it } from 'vitest'
import { createTurboFluxRequestHeaders, getTurboFluxClientIdentity } from './clientIdentity'

describe('TurboFlux client identity', () => {
  it('identifies CLI requests with product, version and request id', () => {
    const headers = createTurboFluxRequestHeaders({}, 'request-123')

    expect(headers['User-Agent']).toMatch(/^turboflux-cli\/\d+\.\d+\.\d+ \(.+; .+\)$/)
    expect(headers['x-app']).toBe('turboflux-cli')
    expect(headers['x-client-app']).toBe('turboflux-cli')
    expect(headers.originator).toBe('turboflux_cli')
    expect(headers['x-client-request-id']).toBe('request-123')
  })

  it('supports a future desktop surface without another header implementation', () => {
    const identity = getTurboFluxClientIdentity({ TURBOFLUX_CLIENT_SURFACE: 'desktop' })

    expect(identity.product).toBe('turboflux-desktop')
    expect(identity.originator).toBe('turboflux_desktop')
    expect(identity.userAgent).toContain('turboflux-desktop/')
  })

  it('lets explicit provider headers override defaults', () => {
    const headers = createTurboFluxRequestHeaders({ 'x-app': 'gateway-required-value' }, 'request-456')

    expect(headers['x-app']).toBe('gateway-required-value')
  })
})
