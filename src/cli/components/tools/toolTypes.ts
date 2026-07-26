export interface ToolStatus {
  id?: string
  name: string
  status: 'running' | 'done' | 'error'
  output?: string
  args?: string
  startTime?: number
  endTime?: number
}

export interface StreamingToolDraft {
  id: string
  name: string
  partialJson: string
  startedAt: number
  updatedAt: number
}
