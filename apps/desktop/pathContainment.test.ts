import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPathInside } from './pathContainment.js'

describe('desktop path containment', () => {
  it('accepts only descendants with POSIX semantics', () => {
    expect(isPathInside('/workspace/attachments', '/workspace/attachments/image.png', posix)).toBe(true)
    expect(isPathInside('/workspace/attachments', '/workspace/secret.png', posix)).toBe(false)
    expect(isPathInside('/workspace/attachments', '/workspace/attachments', posix)).toBe(false)
  })

  it('rejects backslash traversal with Windows semantics', () => {
    expect(isPathInside('C:\\workspace\\attachments', 'C:\\workspace\\attachments\\image.png', win32)).toBe(true)
    expect(isPathInside('C:\\workspace\\attachments', 'C:\\workspace\\secret.png', win32)).toBe(false)
    expect(isPathInside('C:\\workspace\\attachments', 'D:\\secret.png', win32)).toBe(false)
  })
})
