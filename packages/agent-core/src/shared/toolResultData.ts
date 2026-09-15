import type { ToolResult } from './agentTypes'
import type { GitSnapshot } from '../core/gitService'
import type { WebSearchResponse, WebFetchResponse } from '../tools/executor'

export type ToolResultData =
  | {
      kind: 'command'
      command?: string
      cwd?: string
      stdout: string
      stderr?: string
      error?: string
      exitCode?: number
      status?: string
      sessionId?: string
      truncated?: boolean
      timedOut?: boolean
    }
  | { kind: 'repository'; snapshot: GitSnapshot }
  | { kind: 'web_search'; response: WebSearchResponse }
  | { kind: 'web_fetch'; response: WebFetchResponse }
  | { kind: 'items'; items: Array<{ title: string; description?: string; path?: string; status?: string }> }

type ToolResultDetails = Pick<ToolResult, 'retrieval' | 'data' | 'errorKind' | 'interruption' | 'changeSummary' | 'attachments'>

export function copyToolResultDetails(result: ToolResultDetails): ToolResultDetails {
  return structuredClone({
    ...(result.retrieval ? { retrieval: result.retrieval } : {}),
    ...(result.data ? { data: result.data } : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    ...(result.interruption ? { interruption: result.interruption } : {}),
    ...(result.changeSummary ? { changeSummary: result.changeSummary } : {}),
    ...(result.attachments?.length ? { attachments: result.attachments } : {}),
  })
}
