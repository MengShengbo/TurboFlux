import type { SandboxBackendAdapter } from '../types'

function quoteProfilePath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export const sandboxExecBackend: SandboxBackendAdapter = {
  id: 'sandbox-exec',
  build(request, context) {
    const workspace = quoteProfilePath(context.workspacePath)
    const hostHome = quoteProfilePath(context.hostHome)
    const profile = [
      '(version 1)',
      '(allow default)',
      context.status.policy === 'workspace' ? '(deny file-write*)' : '',
      context.status.policy === 'workspace' ? `(allow file-write* (subpath "${workspace}") (subpath "/private/tmp") (subpath "/tmp"))` : '',
      context.status.policy === 'workspace' ? `(deny file-read* (subpath "${hostHome}"))` : '',
      context.status.policy === 'workspace' ? `(allow file-read* (subpath "${workspace}"))` : '',
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
