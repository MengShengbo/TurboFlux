import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('application Workbench ownership boundary', () => {
  it('stays independent from terminal and desktop UI implementations', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url))
    const sourceFiles = readdirSync(directory)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))

    for (const file of sourceFiles) {
      const source = readFileSync(join(directory, file), 'utf8')
      expect(source).not.toMatch(/from ['"][^'"]*\/cli\//)
      expect(source).not.toMatch(/from ['"](?:ink|react|electron|@tauri-apps)/)
    }
  })
})
