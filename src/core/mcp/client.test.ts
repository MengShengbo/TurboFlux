import { describe, expect, it } from 'vitest'
import { buildMcpEnvironment } from './client'

describe('McpClient environment handling', () => {
  it('passes only a minimal inherited environment plus explicit server env', () => {
    const env = buildMcpEnvironment({
      command: 'node',
      enabled: true,
      env: {
        TURBOFLUX_API_KEY: 'explicit-secret',
        CUSTOM_SETTING: 'enabled',
      },
    }, {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TURBOFLUX_API_KEY: 'parent-secret',
      AWS_SECRET_ACCESS_KEY: 'parent-cloud-secret',
      HOME: 'C:\\Users\\admin',
    })

    expect(env.Path).toBe('C:\\Windows\\System32')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.TURBOFLUX_API_KEY).toBe('explicit-secret')
    expect(env.CUSTOM_SETTING).toBe('enabled')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('HOME')
  })
})
