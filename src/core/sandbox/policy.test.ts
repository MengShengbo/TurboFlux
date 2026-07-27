import { describe, expect, it } from 'vitest'
import { resolveSandboxStatus } from './policy'

describe('sandbox backend resolution', () => {
  it('keeps default guarded execution stable even when OS backends are installed', () => {
    const status = resolveSandboxStatus('/workspace', {}, {
      platform: 'linux',
      executableAvailable: () => true,
    })

    expect(status.resolvedBackend).toBe('guarded')
    expect(status.osIsolation).toBe(false)
  })

  it('fails closed when strict isolation has no OS backend', () => {
    const status = resolveSandboxStatus('/workspace', {
      policy: 'workspace',
      enforcement: 'strict',
      backend: 'auto',
    }, {
      platform: 'win32',
      executableAvailable: () => false,
    })

    expect(status).toMatchObject({
      available: false,
      resolvedBackend: 'guarded',
      osIsolation: false,
    })
    expect(status.reason).toContain('Strict enforcement')
  })

  it('selects bubblewrap automatically on Linux', () => {
    const status = resolveSandboxStatus('/workspace', {
      policy: 'workspace',
      enforcement: 'strict',
      network: 'deny',
    }, {
      platform: 'linux',
      executableAvailable: name => name === 'bwrap',
    })

    expect(status).toMatchObject({
      available: true,
      resolvedBackend: 'bubblewrap',
      osIsolation: true,
      networkIsolated: true,
    })
  })

  it('does not pretend guarded mode can deny process networking', () => {
    const status = resolveSandboxStatus('/workspace', {
      policy: 'workspace',
      enforcement: 'guarded',
      network: 'deny',
      backend: 'guarded',
    })

    expect(status.available).toBe(false)
    expect(status.reason).toContain('Network denial')
  })

  it('keeps read-only mode available without a process backend', () => {
    const status = resolveSandboxStatus('/workspace', {
      policy: 'readonly',
      enforcement: 'strict',
      network: 'deny',
    })

    expect(status).toMatchObject({ available: true, writableRoots: [], networkIsolated: true })
  })

  it('does not report read-only networking as isolated when web access is allowed', () => {
    const status = resolveSandboxStatus('/workspace', {
      policy: 'readonly',
      network: 'allow',
    })

    expect(status.networkIsolated).toBe(false)
  })
})
