import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SandboxBackendAdapter } from '../types'

const CONTAINER_WORKSPACE = '/workspace'
const CONTAINER_ENV_ALLOW = /^(?:LANG|LANGUAGE|LC_.+|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR|TURBOFLUX_SANDBOX_.+)$/i
const HOST_PATH_ENV = /^(?:PATH|PATHEXT|HOME|USERPROFILE|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|XDG_.+|COMSPEC|SYSTEMROOT|SHELL)$/i

function mapWorkspacePath(path: string, workspacePath: string): string | null {
  const rel = relative(workspacePath, path)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return rel ? `${CONTAINER_WORKSPACE}/${rel.split(sep).join('/')}` : CONTAINER_WORKSPACE
  }
  return null
}

function mapWorkspaceValue(value: string, workspacePath: string): string {
  const normalizedValue = value.replace(/\\/g, '/')
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/')
  const source = process.platform === 'win32' ? normalizedValue.toLowerCase() : normalizedValue
  const target = process.platform === 'win32' ? normalizedWorkspace.toLowerCase() : normalizedWorkspace
  let cursor = 0
  let index = source.indexOf(target)
  if (index < 0) return value
  let mapped = ''
  while (index >= 0) {
    mapped += normalizedValue.slice(cursor, index) + CONTAINER_WORKSPACE
    cursor = index + normalizedWorkspace.length
    index = source.indexOf(target, cursor)
  }
  return mapped + normalizedValue.slice(cursor)
}

export const dockerBackend: SandboxBackendAdapter = {
  id: 'docker',
  build(request, context) {
    const image = context.status.dockerImage
    if (!image) throw new Error('Docker sandbox requires sandboxDockerImage')
    const containerCwd = mapWorkspacePath(request.cwd, context.workspacePath) || CONTAINER_WORKSPACE
    const mappedCommand = isAbsolute(request.command)
      ? mapWorkspacePath(request.command, context.workspacePath) || basename(request.command).replace(/\.exe$/i, '') || request.command
      : request.command
    const mappedArgs = request.args.map(value => mapWorkspaceValue(value, context.workspacePath))
    const cidFile = join(context.sandboxTemp, `docker-${randomUUID()}.cid`)
    const args = [
      'run', '--rm', '-i', '--init',
      '--cidfile', cidFile,
      '--read-only',
      '--user', process.platform === 'win32' ? '1000:1000' : `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '2g',
      '--cpus', '2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
      '--volume', `${context.workspacePath}:${CONTAINER_WORKSPACE}`,
      '--workdir', containerCwd,
    ]
    if (context.status.network === 'deny') args.push('--network', 'none')
    const containerEnvironment: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(request.env || {})) {
      if (!HOST_PATH_ENV.test(name)) containerEnvironment[name] = mapWorkspaceValue(value, context.workspacePath)
    }
    Object.assign(containerEnvironment, {
      HOME: `${CONTAINER_WORKSPACE}/.turboflux/sandbox/home`,
      TMP: '/tmp',
      TEMP: '/tmp',
      TMPDIR: '/tmp',
      TURBOFLUX_SANDBOX_POLICY: context.status.policy,
      TURBOFLUX_SANDBOX_ENFORCEMENT: context.status.enforcement,
      TURBOFLUX_SANDBOX_BACKEND: context.status.resolvedBackend,
      TURBOFLUX_SANDBOX_NETWORK: context.status.network,
    })
    for (const [name, value] of Object.entries(context.targetEnvironment)) {
      if (value !== undefined && CONTAINER_ENV_ALLOW.test(name)) containerEnvironment[name] = value
    }
    const hostEnvironment = { ...context.hostEnvironment }
    for (const [name, value] of Object.entries(containerEnvironment)) {
      if (value !== undefined) {
        hostEnvironment[name] = value
        args.push('--env', name)
      }
    }
    args.push(image, mappedCommand, ...mappedArgs)
    return {
      command: 'docker',
      args,
      cwd: context.workspacePath,
      env: hostEnvironment,
      status: context.status,
      cleanup: { kind: 'docker', cidFile },
    }
  },
}
