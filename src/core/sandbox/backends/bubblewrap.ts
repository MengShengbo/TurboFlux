import type { SandboxBackendAdapter } from '../types'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'

const SANDBOX_WORKSPACE = '/workspace'

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

export const bubblewrapBackend: SandboxBackendAdapter = {
  id: 'bubblewrap',
  build(request, context) {
    const workspaceRelativeCwd = relative(context.workspacePath, request.cwd)
    const sandboxCwd = workspaceRelativeCwd
      ? `${SANDBOX_WORKSPACE}/${workspaceRelativeCwd.replace(/\\/g, '/')}`
      : SANDBOX_WORKSPACE
    const mapWorkspaceValue = (value: string) => {
      const mapped = value.split(context.workspacePath).join(SANDBOX_WORKSPACE)
      return mapped === value ? value : mapped.replace(/\\/g, '/')
    }
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      context.status.policy === 'full' ? '--bind' : '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
    ]
    let environment = context.targetEnvironment
    if (context.status.policy === 'workspace') {
      const hiddenRoots = new Set([
        dirname(context.hostHome),
        '/root',
        '/mnt',
        '/media',
        '/Volumes',
        '/run',
      ].filter(path => path !== '/' && existsSync(path)))
      if (isAbsolute(request.command) && [...hiddenRoots].some(root => isWithin(root, request.command))) {
        if (!isWithin(context.workspacePath, request.command)) {
          throw new Error('Strict Bubblewrap cannot execute a tool from a hidden user directory; use a system toolchain or Docker image.')
        }
      }
      environment = Object.fromEntries(Object.entries(context.targetEnvironment).map(([name, value]) => [
        name,
        value === undefined ? value : mapWorkspaceValue(value),
      ]))
      environment.PATH = String(context.targetEnvironment.PATH || '')
        .split(':')
        .filter(path => !isAbsolute(path) || isWithin(context.workspacePath, path) || ![...hiddenRoots].some(root => isWithin(root, path)))
        .map(mapWorkspaceValue)
        .join(':')
      args.push('--dir', SANDBOX_WORKSPACE, '--bind', context.workspacePath, SANDBOX_WORKSPACE)
      for (const path of hiddenRoots) args.push('--tmpfs', path)
    }
    args.push('--tmpfs', '/tmp')
    if (context.status.network === 'deny') args.push('--unshare-net')
    const command = context.status.policy === 'workspace' ? mapWorkspaceValue(request.command) : request.command
    const commandArgs = context.status.policy === 'workspace' ? request.args.map(mapWorkspaceValue) : request.args
    args.push(
      '--chdir', context.status.policy === 'workspace' ? sandboxCwd : request.cwd,
      '--setenv', 'HOME', context.status.policy === 'workspace' ? `${SANDBOX_WORKSPACE}/.turboflux/sandbox/home` : context.sandboxHome,
      '--setenv', 'TMPDIR', '/tmp',
      '--', command, ...commandArgs,
    )
    return {
      command: 'bwrap',
      args,
      cwd: request.cwd,
      env: environment,
      status: context.status,
    }
  },
}
