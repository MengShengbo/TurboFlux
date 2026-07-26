import { describe, expect, it } from 'vitest'
import { getChildProcessSpawnOptions, getDefaultShellSpec, getProcessGroupSignal, usesProcessGroup } from './process'

describe('platform process adapter', () => {
  it('selects native shells for each supported desktop platform', () => {
    expect(getDefaultShellSpec('win32')).toMatchObject({ command: 'powershell.exe', id: 'powershell' })
    expect(getDefaultShellSpec('linux')).toMatchObject({ command: '/bin/bash', id: 'bash' })
    expect(getDefaultShellSpec('darwin')).toMatchObject({ command: '/bin/zsh', id: 'zsh' })
  })

  it('uses process groups on POSIX and windowsHide on Windows', () => {
    expect(usesProcessGroup('win32')).toBe(false)
    expect(usesProcessGroup('linux')).toBe(true)
    expect(usesProcessGroup('darwin')).toBe(true)
    expect(getChildProcessSpawnOptions('win32')).toMatchObject({ detached: false, windowsHide: true })
    expect(getChildProcessSpawnOptions('linux')).toMatchObject({ detached: true })
    expect(getProcessGroupSignal()).toBe('SIGTERM')
  })
})
