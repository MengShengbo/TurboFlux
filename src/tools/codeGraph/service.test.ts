import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeGraphService } from './service.js'

describe('CodeGraphService', () => {
  it('indexes symbols and exposes call relationships', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-codegraph-'))
    writeFileSync(join(workspace, 'workflow.ts'), [
      'export function runWorkflow() {',
      '  return loadWorkspace()',
      '}',
      'export function loadWorkspace() {',
      "  return 'ready'",
      '}',
    ].join('\n'), 'utf-8')

    try {
      const service = await CodeGraphService.load()
      await service.prepare(workspace)
      const symbols = await service.searchSymbols({
        workspacePath: workspace,
        query: 'loadWorkspace',
        limit: 5,
      })
      const map = await service.getCodeMap({
        workspacePath: workspace,
        query: 'loadWorkspace workflow',
        depth: 2,
        maxPaths: 5,
      })

      expect(symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'loadWorkspace', path: 'workflow.ts', line: 4 }),
      ]))
      expect(JSON.stringify(map.map)).toContain('runWorkflow')
      expect(JSON.stringify(map.map)).toContain('[caller]')
      expect(map.map[0]?.title).toBe('loadWorkspace')
      expect(map.relatedPaths).toContain('workflow.ts')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 15_000)
})
