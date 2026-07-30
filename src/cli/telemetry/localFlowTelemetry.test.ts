import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFlowTelemetry } from './localFlowTelemetry'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LocalFlowTelemetry', () => {
  it('persists only typed numeric aggregates', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-private-prompt-do-not-record-'))
    directories.push(workspace)
    const outputFile = join(workspace, 'metrics.json')
    const telemetry = new LocalFlowTelemetry(workspace, { outputFile, autoFlush: false })
    telemetry.count('ui.key_received', 3)
    telemetry.observe('ui.stream_oldest_age_ms', 42)
    telemetry.observe('ui.key_to_terminal_flush_ms', 12)
    telemetry.flush()

    const raw = readFileSync(outputFile, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.counters['ui.key_received']).toBe(3)
    expect(parsed.histograms['ui.stream_oldest_age_ms']).toMatchObject({ count: 1, sum: 42, min: 42, max: 42 })
    expect(parsed.histograms['ui.key_to_terminal_flush_ms']).toMatchObject({ count: 1, sum: 12, min: 12, max: 12 })
    expect(raw).not.toContain(workspace)
    expect(raw).not.toContain('private-prompt-do-not-record')
  })

  it('can be disabled without touching disk', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-telemetry-off-'))
    directories.push(workspace)
    const outputFile = join(workspace, 'metrics.json')
    const telemetry = new LocalFlowTelemetry(workspace, { outputFile, enabled: false, autoFlush: false })
    telemetry.count('ui.key_received')

    expect(telemetry.flush()).toBe(true)
    expect(() => readFileSync(outputFile, 'utf8')).toThrow()
  })

  it('loads and aggregates a prior local snapshot', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-telemetry-load-'))
    directories.push(workspace)
    const outputFile = join(workspace, 'metrics.json')
    const first = new LocalFlowTelemetry(workspace, { outputFile, autoFlush: false })
    first.count('ui.stream_flush', 2)
    first.flush()

    const second = new LocalFlowTelemetry(workspace, { outputFile, autoFlush: false })
    second.count('ui.stream_flush')
    expect(second.getSnapshot().counters['ui.stream_flush']).toBe(3)
  })

  it('ignores samples after destruction', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-telemetry-destroyed-'))
    directories.push(workspace)
    const outputFile = join(workspace, 'metrics.json')
    const telemetry = new LocalFlowTelemetry(workspace, { outputFile, autoFlush: false })
    telemetry.count('ui.key_received')
    telemetry.destroy()
    telemetry.count('ui.key_received')

    expect(telemetry.getSnapshot().counters['ui.key_received']).toBe(1)
  })
})
