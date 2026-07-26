import type { SpawnOptions } from 'node:child_process'

export interface ShellSpec {
  command: string
  args: string[]
  id: string
  label: string
}

export type SupportedProcessPlatform = 'win32' | 'linux' | 'darwin' | (string & {})

export function getDefaultShellSpec(platform: SupportedProcessPlatform = process.platform): ShellSpec {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
      id: 'powershell',
      label: 'PowerShell',
    }
  }
  if (platform === 'darwin') {
    return { command: '/bin/zsh', args: [], id: 'zsh', label: 'Zsh' }
  }
  return { command: '/bin/bash', args: [], id: 'bash', label: 'Bash' }
}

export function getChildProcessSpawnOptions(platform: SupportedProcessPlatform = process.platform): SpawnOptions & { stdio: 'pipe' } {
  return {
    detached: platform !== 'win32',
    stdio: 'pipe',
    ...(platform === 'win32' ? { windowsHide: true } : {}),
  }
}

export function usesProcessGroup(platform: SupportedProcessPlatform = process.platform): boolean {
  return platform !== 'win32'
}

export function getProcessGroupSignal(): NodeJS.Signals {
  return 'SIGTERM'
}
