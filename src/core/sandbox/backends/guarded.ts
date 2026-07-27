import type { SandboxBackendAdapter } from '../types'

export const guardedBackend: SandboxBackendAdapter = {
  id: 'guarded',
  build(request, context) {
    return {
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: context.targetEnvironment,
      status: context.status,
    }
  },
}
