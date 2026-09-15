import type { McpClient } from '@turboflux/agent-core/extensions'

export interface AgentSystemCapability<TSnapshot> {
  register(client: McpClient): void
  setWorkspacePath(workspacePath: string): void
  getSnapshot(): TSnapshot
  finishTask(): Promise<void>
  destroy(): void
}

export interface RuntimePausableSystemCapability<TSnapshot> extends AgentSystemCapability<TSnapshot> {
  pauseForRuntime(): TSnapshot
  resumeForRuntime(): TSnapshot
}
