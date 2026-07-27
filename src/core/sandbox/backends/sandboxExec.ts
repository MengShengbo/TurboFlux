import { dirname } from 'node:path'
import type { SandboxBackendAdapter } from '../types'

function quoteProfilePath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export const sandboxExecBackend: SandboxBackendAdapter = {
  id: 'sandbox-exec',
  build(request, context) {
    const workspace = quoteProfilePath(context.workspacePath)
    const homeParent = quoteProfilePath(dirname(process.env.HOME || context.sandboxHome))
    const profile = [
      '(version 1)',
      '(allow default)',
      context.status.policy === 'workspace' ? '(deny file-write*)' : '',
      context.status.policy === 'workspace' ? `(allow file-write* (subpath "${workspace}") (subpath "/private/tmp") (subpath "/tmp"))` : '',
      `(deny file-read* (subpath "${homeParent}"))`,
      `(allow file-read* (subpath "${workspace}"))`,
      context.status.network === 'deny' ? '(deny network*)' : '',
    ].filter(Boolean).join('\n')
    return {
      command: 'sandbox-exec',
      args: ['-p', profile, request.command, ...request.args],
      cwd: request.cwd,
      env: context.targetEnvironment,
      status: context.status,
    }
  },
}
