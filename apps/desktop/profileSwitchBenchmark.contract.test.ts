import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('hidden profile switch performance benchmark', () => {
  it('uses real profile and runtime boundaries without creating or foregrounding a window', () => {
    const entry = readFileSync(resolve('profileSwitchBenchmark.entry.ts'), 'utf8')
    const runner = readFileSync(resolve('../../scripts/desktop-profile-switch-benchmark.mjs'), 'utf8')
    expect(entry).toContain('InstallationProfileRegistry')
    expect(entry).toContain('DesktopRuntimeHost.create')
    expect(entry).toContain('switchDesktopProfile({')
    expect(entry).toContain('const P95_BUDGET_MS = 2_000')
    expect(entry).toContain('const STAGE_TIMEOUT_MS = 15_000')
    expect(entry).toContain("app.once('ready', () => app.dock?.hide())")
    expect(entry).not.toMatch(/BrowserWindow|\.show\(|\.focus\(|\.restore\(/u)
    expect(runner).toContain("external: ['electron']")
  })

  it('atomically writes sanitized schema v2 benchmark evidence with provenance', () => {
    const entry = readFileSync(resolve('profileSwitchBenchmark.entry.ts'), 'utf8')
    const archive = readFileSync(resolve('../../scripts/profile-archive-benchmark.ts'), 'utf8')
    const conversations = readFileSync(resolve('../../scripts/conversation-v2-benchmark.ts'), 'utf8')
    const workflow = readFileSync(resolve('../../.github/workflows/ci.yml'), 'utf8')
    for (const source of [entry, archive, conversations]) {
      expect(source).toContain('schemaVersion: 2')
      expect(source).toContain('provenance: captureGithubActionsProvenance()')
      expect(source).toContain('writeSourceEvidenceReportAtomically')
      expect(source).not.toMatch(/writeFile\(reportPath/u)
      expect(source).not.toContain('error.stack')
    }
    expect(conversations).toContain("'profile-benchmarks', `conversation-v2-stable-${process.platform}-${process.arch}.json`")
    expect(conversations).not.toContain('generated/profile-qa/conversation-v2-benchmark.json')
    expect(conversations).toContain("process.stderr.write('Conversation V2 benchmark failed\\n')")
    expect(workflow).toContain('path: apps/desktop/generated/profile-benchmarks/*.json')
    expect(entry).toContain("process.stderr.write('[profile-switch-benchmark] failed\\n')")
    expect(archive).toContain("process.stderr.write('Profile archive benchmark failed\\n')")
  })
})
