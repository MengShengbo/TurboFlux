import type { McpClient } from '@turboflux/extensions/mcp/client'

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
