import { describe, expect, it } from 'vitest'
import type { SandboxStatus } from '../sandbox/types'
import {
  assertSecurityCommandScope,
  buildSecurityResearchPrompt,
  createSecurityResearchProfile,
  normalizeSecurityTarget,
  parseSecurityCommand,
} from './researchMode'

const strictSandbox: SandboxStatus = {
  policy: 'workspace',
  enforcement: 'strict',
  network: 'allow',
  backend: 'docker',
  resolvedBackend: 'docker',
  dockerImage: 'turboflux-sandbox',
  available: true,
  osIsolation: true,
  networkIsolated: false,
  writableRoots: ['/workspace'],
}

describe('security research mode', () => {
  it('parses and normalizes an explicit red-team scope', () => {
    expect(parseSecurityCommand('red HTTPS://Example.COM/path, 10.20.0.0/16 | verify the exposed API')).toEqual({
      mode: 'red',
      targets: ['example.com', '10.20.0.0/16'],
      objective: 'verify the exposed API',
    })
  })

  it('accepts named defensive assets without weakening red-team target validation', () => {
    expect(parseSecurityCommand('blue prod-web-01 | investigate authentication alerts').targets).toEqual(['prod-web-01'])
    expect(() => normalizeSecurityTarget('prod-web-01')).toThrow('Invalid target')
  })

  it('rejects wildcards and internet-wide ranges', () => {
    expect(() => parseSecurityCommand('red *.example.com | scan')).toThrow('Wildcard')
    expect(() => parseSecurityCommand('red 0.0.0.0/0 | scan')).toThrow('Internet-wide')
  })

  it('requires strict OS isolation and active approvals for red-team mode', () => {
    const parsed = parseSecurityCommand('red example.com | validate one endpoint')
    expect(() => createSecurityResearchProfile(parsed, {
      sandboxStatus: { ...strictSandbox, enforcement: 'guarded', osIsolation: false },
      approvalPolicy: 'ask',
    })).toThrow('strict OS-isolated sandbox')
    expect(() => createSecurityResearchProfile(parsed, {
      sandboxStatus: strictSandbox,
      approvalPolicy: 'full',
    })).toThrow('cannot run with approval policy')
  })

  it('builds a bounded research contract rather than a policy-bypass prompt', () => {
    const profile = createSecurityResearchProfile(
      parseSecurityCommand('red example.com | confirm a reported authorization flaw'),
      { sandboxStatus: strictSandbox, approvalPolicy: 'agent', now: 1_000, durationMs: 5_000 },
    )
    const prompt = buildSecurityResearchPrompt(profile, 2_000) || ''
    expect(prompt).toContain('<security_research_contract>')
    expect(prompt).toContain('example.com')
    expect(prompt).toContain('minimal proof of concept')
    expect(prompt).toContain('Do not bypass provider policy')
    expect(prompt).toContain('denial of service')
  })

  it('allows scoped active commands and rejects mixed or missing destinations', () => {
    const profile = createSecurityResearchProfile(
      parseSecurityCommand('red example.com,10.20.0.0/16 | bounded validation'),
      { sandboxStatus: strictSandbox, approvalPolicy: 'ask', now: 1_000, durationMs: 10_000 },
    )
    expect(() => assertSecurityCommandScope('curl https://example.com/health', profile, 2_000)).not.toThrow()
    expect(() => assertSecurityCommandScope('nmap -sV 10.20.4.8', profile, 2_000)).not.toThrow()
    expect(() => assertSecurityCommandScope('curl https://example.com && curl https://outside.test', profile, 2_000)).toThrow('outside the authorized scope')
    expect(() => assertSecurityCommandScope('nmap outside.test example.com', profile, 2_000)).toThrow('outside the authorized scope')
    expect(() => assertSecurityCommandScope('nmap -sV', profile, 2_000)).toThrow('does not explicitly reference')
  })

  it('supports IPv6 targets and CIDR membership checks', () => {
    const profile = createSecurityResearchProfile(
      parseSecurityCommand('red 2001:db8:1::/64 | bounded validation'),
      { sandboxStatus: strictSandbox, approvalPolicy: 'ask', now: 1_000, durationMs: 10_000 },
    )
    expect(() => assertSecurityCommandScope('nmap 2001:db8:1::25', profile, 2_000)).not.toThrow()
    expect(() => assertSecurityCommandScope('nmap 2001:db8:2::25', profile, 2_000)).toThrow('outside the authorized scope')
  })

  it('fails closed after the engagement expires', () => {
    const profile = createSecurityResearchProfile(
      parseSecurityCommand('red example.com | bounded validation'),
      { sandboxStatus: strictSandbox, approvalPolicy: 'ask', now: 1_000, durationMs: 500 },
    )
    expect(() => assertSecurityCommandScope('curl https://example.com', profile, 2_000)).toThrow('expired')
  })
})
