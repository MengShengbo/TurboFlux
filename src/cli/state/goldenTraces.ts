export const GOLDEN_TRACE_NAMES = [
  'plain-text-answer',
  'write-file-approval',
  'parallel-mcp-approvals',
  'streaming-steer',
  'turn-tail-steer-race',
  'recoverable-error-queued-input',
  'interrupt-before-first-token',
  'tool-crash-recovery',
  'long-table-stream-resize',
  'background-thread-approval',
  'ten-thousand-line-transcript',
  'windows-paste-and-ime',
] as const

export type GoldenTraceName = typeof GOLDEN_TRACE_NAMES[number]
