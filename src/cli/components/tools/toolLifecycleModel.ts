import type { ToolStatus } from './toolTypes'

export interface ToolCallStarted {
  id: string
  name: string
  args?: string
  startedAt: number
}

export interface ToolCallSettled {
  id: string
  name: string
  status: 'done' | 'error'
  output?: string
  settledAt: number
}

export function beginToolCall(current: ToolStatus[], event: ToolCallStarted): ToolStatus[] {
  const existing = current.find(tool => tool.id === event.id)
  const runningTool: ToolStatus = {
    id: event.id,
    name: event.name,
    status: 'running',
    args: event.args,
    startTime: existing?.startTime ?? event.startedAt,
  }
  return existing
    ? current.map(tool => tool.id === event.id ? runningTool : tool)
    : [...current, runningTool]
}

export function settleToolCall(current: ToolStatus[], event: ToolCallSettled): ToolStatus[] {
  const existing = current.find(tool => tool.id === event.id)
  if (!existing) {
    return [...current, {
      id: event.id,
      name: event.name,
      status: event.status,
      output: event.output,
      startTime: event.settledAt,
      endTime: event.settledAt,
    }]
  }
  return current.map(tool => tool.id === event.id
    ? { ...tool, status: event.status, output: event.output, endTime: event.settledAt }
    : tool
  )
}
