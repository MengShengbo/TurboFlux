import React, { useEffect, useMemo, useRef } from 'react'
import { Box, useBoxMetrics, type DOMElement } from 'ink'
import { MessageList } from './MessageList'
import type { Message } from './Messages'
import { describeTranscriptCells, projectTranscriptCellWindow } from '../transcriptWindowing'

interface WindowedMessageListProps {
  messages: Message[]
  verbose: boolean
  viewportRows: number
  scrollRowsFromBottom: number
  selectedMessageId?: string
  selectedMessageRef?: React.Ref<DOMElement>
  showThinking?: boolean
  showToolDetails?: boolean
  availableWidth: number
  overscanRows?: number
  onWindowMetrics?: (metrics: { mountedCells: number; totalCells: number }) => void
}

export function WindowedMessageList({
  messages,
  verbose,
  viewportRows,
  scrollRowsFromBottom,
  selectedMessageId,
  selectedMessageRef,
  showThinking = verbose,
  showToolDetails = verbose,
  availableWidth,
  overscanRows = 12,
  onWindowMetrics,
}: WindowedMessageListProps) {
  const [measuredRows, setMeasuredRows] = React.useState<Record<string, number>>({})
  const windowRef = useRef<DOMElement>(null)
  const cellRefs = useRef(new Map<string, DOMElement>())
  const windowMetrics = useBoxMetrics(windowRef)
  const cells = useMemo(
    () => describeTranscriptCells(messages, availableWidth, showThinking),
    [availableWidth, messages, showThinking],
  )
  const window = useMemo(() => projectTranscriptCellWindow(
    cells,
    measuredRows,
    viewportRows,
    scrollRowsFromBottom,
    overscanRows,
    selectedMessageId,
  ), [cells, measuredRows, overscanRows, scrollRowsFromBottom, selectedMessageId, viewportRows])

  useEffect(() => {
    setMeasuredRows({})
  }, [availableWidth, showThinking, showToolDetails])

  useEffect(() => {
    onWindowMetrics?.({
      mountedCells: window.endIndex - window.startIndex,
      totalCells: messages.length,
    })
  }, [messages.length, onWindowMetrics, window.endIndex, window.startIndex])

  const visibleMessages = useMemo(
    () => messages.slice(window.startIndex, window.endIndex),
    [messages, window.endIndex, window.startIndex],
  )

  useEffect(() => {
    const measured: Record<string, number> = {}
    for (const message of visibleMessages) {
      const height = cellRefs.current.get(message.id)?.yogaNode?.getComputedLayout().height ?? 0
      if (height > 0) measured[message.id] = height
    }
    if (Object.keys(measured).length === 0) return
    setMeasuredRows(current => {
      const changed = Object.entries(measured).some(([id, rows]) => current[id] !== rows)
      return changed ? { ...current, ...measured } : current
    })
  }, [visibleMessages, windowMetrics.height, windowMetrics.width])

  return (
    <Box ref={windowRef} flexDirection="column" flexShrink={0}>
      {window.paddingTopRows > 0 && <Box height={window.paddingTopRows} flexShrink={0} />}
      {visibleMessages.map(message => (
        <Box
          key={message.id}
          ref={node => {
            if (node) cellRefs.current.set(message.id, node)
            else cellRefs.current.delete(message.id)
          }}
          flexDirection="column"
          flexShrink={0}
        >
          <MessageList
            messages={[message]}
            verbose={verbose}
            selectedMessageId={selectedMessageId}
            selectedMessageRef={selectedMessageId === message.id ? selectedMessageRef : undefined}
            showThinking={showThinking}
            showToolDetails={showToolDetails}
            availableWidth={availableWidth}
          />
        </Box>
      ))}
      {window.paddingBottomRows > 0 && <Box height={window.paddingBottomRows} flexShrink={0} />}
    </Box>
  )
}
