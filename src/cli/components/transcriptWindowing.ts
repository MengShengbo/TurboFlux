import stringWidth from 'string-width'
import type { Message } from './messages/Messages'
import { clampTranscriptScroll } from './TranscriptViewport'

export interface TranscriptCellDescriptor {
  id: string
  estimatedRows: number
}

export interface TranscriptCellWindow {
  startIndex: number
  endIndex: number
  paddingTopRows: number
  paddingBottomRows: number
  totalRows: number
  maxScrollRows: number
  topRow: number
  bottomRow: number
  mountedRows: number
}

function wrappedRows(value: string, width: number): number {
  if (!value) return 0
  const safeWidth = Math.max(1, Math.floor(width))
  return value.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(stringWidth(line) / safeWidth)), 0)
}

export function estimateTranscriptMessageRows(
  message: Message,
  availableWidth: number,
  showThinking = false,
): number {
  const contentWidth = Math.max(8, Math.floor(availableWidth) - 2)
  let rows = 1
  if (message.role === 'user' || message.role === 'system') {
    rows += wrappedRows(message.content, contentWidth)
  } else {
    rows += wrappedRows(message.content, contentWidth)
    if (message.interrupted) rows += 1
    if (message.thinking) {
      rows += showThinking ? 2 + wrappedRows(message.thinking.content, contentWidth) : 1
    }
    if (message.tools?.length) rows += message.tools.length * 2 + 1
    for (const change of message.changes || []) {
      const beforeRows = change.before ? change.before.split('\n').length : 0
      const afterRows = change.after ? change.after.split('\n').length : 0
      rows += Math.max(beforeRows, afterRows, 1) + 4
    }
  }
  return Math.max(1, rows)
}

export function describeTranscriptCells(
  messages: Message[],
  availableWidth: number,
  showThinking = false,
): TranscriptCellDescriptor[] {
  return messages.map(message => ({
    id: message.id,
    estimatedRows: estimateTranscriptMessageRows(message, availableWidth, showThinking),
  }))
}

export function projectTranscriptCellWindow(
  cells: TranscriptCellDescriptor[],
  measuredRows: Readonly<Record<string, number>>,
  viewportRows: number,
  scrollRowsFromBottom: number,
  overscanRows = 12,
  pinnedCellId?: string,
): TranscriptCellWindow {
  const heights = cells.map(cell => Math.max(1, Math.floor(measuredRows[cell.id] ?? cell.estimatedRows)))
  const prefix = new Array<number>(cells.length + 1).fill(0)
  for (let index = 0; index < heights.length; index += 1) {
    prefix[index + 1] = prefix[index]! + heights[index]!
  }
  const totalRows = prefix[cells.length] ?? 0
  const safeViewportRows = Math.max(1, Math.floor(viewportRows))
  const maxScrollRows = Math.max(0, totalRows - safeViewportRows)
  const normalizedScroll = clampTranscriptScroll(scrollRowsFromBottom, maxScrollRows)
  let topRow = maxScrollRows - normalizedScroll
  let bottomRow = Math.min(totalRows, topRow + safeViewportRows)

  const pinnedIndex = pinnedCellId ? cells.findIndex(cell => cell.id === pinnedCellId) : -1
  if (pinnedIndex >= 0) {
    const pinnedTop = prefix[pinnedIndex]!
    const pinnedBottom = prefix[pinnedIndex + 1]!
    if (pinnedBottom <= topRow || pinnedTop >= bottomRow) {
      topRow = Math.max(0, Math.min(maxScrollRows, pinnedTop - Math.floor(safeViewportRows / 3)))
      bottomRow = Math.min(totalRows, topRow + safeViewportRows)
    }
  }

  const targetTop = Math.max(0, topRow - Math.max(0, overscanRows))
  const targetBottom = Math.min(totalRows, bottomRow + Math.max(0, overscanRows))
  let startIndex = 0
  while (startIndex < cells.length && prefix[startIndex + 1]! <= targetTop) startIndex += 1
  let endIndex = startIndex
  while (endIndex < cells.length && prefix[endIndex]! < targetBottom) endIndex += 1

  const paddingTopRows = prefix[startIndex] ?? 0
  const renderedBottom = prefix[endIndex] ?? paddingTopRows
  return {
    startIndex,
    endIndex,
    paddingTopRows,
    paddingBottomRows: Math.max(0, totalRows - renderedBottom),
    totalRows,
    maxScrollRows,
    topRow,
    bottomRow,
    mountedRows: Math.max(0, renderedBottom - paddingTopRows),
  }
}
