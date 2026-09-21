import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('application Flow ownership boundary', () => {
  it('stays independent from UI implementations', () => {
    const directory = join(process.cwd(), 'packages/workbench/src', 'flow')
    const sourceFiles = readdirSync(directory)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))

    for (const file of sourceFiles) {
      const source = readFileSync(join(directory, file), 'utf8')
      expect(source).not.toMatch(/from ['"][^'"]*\/cli\//)
      expect(source).not.toMatch(/from ['"](?:ink|react|electron|@tauri-apps)/)
    }
  })
})
