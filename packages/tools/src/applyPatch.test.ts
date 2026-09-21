import { describe, expect, it } from 'vitest'
import { applyPatchAdd, applyPatchHunks, MAX_APPLY_PATCH_CHARS, parseApplyPatch } from './applyPatch'

describe('apply patch parser', () => {
  it('parses add, update, delete, and move operations', () => {
    const operations = parseApplyPatch(`*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: old.txt
*** Move to: renamed.txt
@@
-old
+new
*** Delete File: remove.txt
*** End Patch`)

    expect(operations).toEqual([
      { kind: 'add', path: 'nested/new.txt', content: 'created\n' },
      {
        kind: 'update',
        path: 'old.txt',
        moveTo: 'renamed.txt',
        hunks: [{ header: '@@', lines: ['-old', '+new'] }],
      },
      { kind: 'delete', path: 'remove.txt' },
    ])
  })

  it('rejects malformed or ambiguous patches', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** End Patch')).toThrow('no file operations')
    expect(() => parseApplyPatch('*** Begin Patch\n*** Update File: a.txt\n@@\n old\n*** End Patch')).toThrow('addition or deletion')
    expect(() => applyPatchHunks('same\nsame\nsame\n', [{ header: '@@', lines: [' same', '-same', '+new'] }], 'a.txt')).toThrow('ambiguous')
  })

  it('applies exact multi-hunk updates and preserves a trailing newline', () => {
    const result = applyPatchHunks('line1\nline2\nline3\nline4\n', [
      { header: '@@', lines: ['-line2', '+changed2'] },
      { header: '@@', lines: ['-line4', '+changed4'] },
    ], 'sample.txt')

    expect(result).toBe('line1\nchanged2\nline3\nchanged4\n')
  })

  it('uses an explicit hunk location for insert-only updates', () => {
    const result = applyPatchHunks('a\nb\n', [{ header: '@@ -2,0 +2,1 @@', lines: ['+inserted'] }], 'sample.txt')
    expect(result).toBe('a\ninserted\nb\n')
  })

  it('normalizes added content', () => {
    expect(applyPatchAdd('one\r\ntwo\r\n')).toBe('one\ntwo\n')
  })

  it('bounds patch input before parsing', () => {
    expect(() => parseApplyPatch(`*** Begin Patch\n${'x'.repeat(MAX_APPLY_PATCH_CHARS)}\n*** End Patch`)).toThrow('character limit')
  })
})
