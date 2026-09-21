import { describe, expect, it } from 'vitest'
import { resolvePath } from './pathUtils'

describe('resolvePath', () => {
  it('accepts absolute paths outside the initial workspace', () => {
    expect(resolvePath('C:/workspace/project', 'D:/shared/file.ts')).toBe('D:/shared/file.ts')
    expect(resolvePath('/workspace/project', '/tmp/shared/file.ts')).toBe('/tmp/shared/file.ts')
  })

  it('allows relative paths to traverse outside the initial workspace', () => {
    expect(resolvePath('C:/workspace/project', '../../shared/file.ts')).toBe('C:/shared/file.ts')
  })

  it('keeps model-style leading slashes relative on Windows', () => {
    expect(resolvePath('C:/workspace/project', '/src/app.ts')).toBe('C:/workspace/project/src/app.ts')
  })
})
