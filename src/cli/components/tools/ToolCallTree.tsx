import React from 'react'
import { ToolActivityList } from './ToolActivityList'
import type { ToolStatus } from './toolTypes'
import { formatToolLabel } from './toolPresentation'

export type { ToolStatus } from './toolTypes'

interface ToolCallTreeProps {
  tools: ToolStatus[]
  verbose: boolean
  expanded?: boolean
  availableWidth?: number
}

export function ToolCallTree({ tools, verbose, expanded = verbose, availableWidth }: ToolCallTreeProps) {
  const visibleTools = tools.filter(shouldPersistToolForHistory)
  return (
    <ToolActivityList
      tools={visibleTools}
      availableWidth={availableWidth}
      showOutputs={verbose || expanded}
    />
  )
}

export function shouldPersistToolForHistory(tool: ToolStatus): boolean {
  return tool.name !== 'read_agent'
}

export function formatToolLabelForHistory(name: string, argsJson?: string): string {
  return formatToolLabel(name, argsJson)
}
