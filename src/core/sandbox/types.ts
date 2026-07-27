import type {
  SandboxBackend,
  SandboxConfig,
  SandboxEnforcement,
  SandboxNetworkPolicy,
  SandboxPolicy,
} from '../../shared/agentTypes'

export type SandboxResolvedBackend = Exclude<SandboxBackend, 'auto'>

export interface SandboxOptions {
  policy?: SandboxPolicy
  enforcement?: SandboxEnforcement
  network?: SandboxNetworkPolicy
  backend?: SandboxBackend
  dockerImage?: string
}

export interface SandboxStatus extends SandboxConfig {
  resolvedBackend: SandboxResolvedBackend
  available: boolean
  osIsolation: boolean
  networkIsolated: boolean
  writableRoots: string[]
  reason?: string
  warning?: string
  auditPath?: string
}

export interface SandboxProcessRequest {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  trustedEnvironment?: boolean
  interactive?: boolean
}

export interface SandboxSpawnPlan {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  status: SandboxStatus
  cleanup?: {
    kind: 'docker'
    cidFile: string
  }
}

export interface SandboxBackendContext {
  workspacePath: string
  sandboxHome: string
  sandboxTemp: string
  hostHome: string
  targetEnvironment: NodeJS.ProcessEnv
  hostEnvironment: NodeJS.ProcessEnv
  status: SandboxStatus
}

export interface SandboxBackendAdapter {
  readonly id: SandboxResolvedBackend
  build(request: SandboxProcessRequest, context: SandboxBackendContext): SandboxSpawnPlan
}
