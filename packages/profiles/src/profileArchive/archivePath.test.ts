import { describe, expect, it } from 'vitest'
import { assertUniqueArchivePaths, normalizeArchivePath } from './archivePath'

describe('profile archive portable paths', () => {
  it('round trips normalized portable relative paths', () => {
    const alphabet = ['a', 'Z', '0', '-', '_', '中', '文', '🙂', ' ']
    let state = 0x5eed1234
    const next = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0
      return state
    }
    for (let sample = 0; sample < 250; sample += 1) {
      const segments = Array.from({ length: 1 + next() % 5 }, () => (
        Array.from({ length: 1 + next() % 12 }, () => alphabet[next() % alphabet.length]).join('').trim() || 'item'
      ))
      const path = segments.join('/')
      expect(normalizeArchivePath(path)).toBe(path.normalize('NFC'))
    }
  })

  it.each([
    '', '.', '..', '../escape', 'safe/../escape', '/absolute', 'C:/escape', 'C:\\escape',
    '\\\\server\\share', 'safe//file', 'safe/./file', 'safe/%2e%2e/file', 'safe/%2F/file',
    'safe/CON.json', 'safe/LPT1', 'safe/name.', 'safe/name ', 'safe/name\0file',
  ])('rejects unsafe path %j', path => {
    expect(() => normalizeArchivePath(path)).toThrow()
  })

  it('rejects case-folded and Unicode-normalized collisions', () => {
    expect(() => assertUniqueArchivePaths(['Items/A.json', 'items/a.json'])).toThrow()
    expect(() => assertUniqueArchivePaths(['items/é.json', 'items/e\u0301.json'])).toThrow()
  })
})
