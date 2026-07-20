import React, { useEffect, useMemo, useRef } from 'react'
import { Box, useBoxMetrics, type DOMElement } from 'ink'

export const DEFAULT_MOUSE_WHEEL_ROWS = 3

export interface TranscriptViewportMetrics {
  contentRows: number
  viewportRows: number
  maxScrollRows: number
}

export interface TranscriptViewportWindow extends TranscriptViewportMetrics {
  scrollRowsFromBottom: number
  topRow: number
  bottomRow: number
}

interface TranscriptViewportProps {
  children: React.ReactNode
  scrollRowsFromBottom: number
  onScrollRowsChange: (rows: number) => void
  onMetricsChange: (metrics: TranscriptViewportMetrics) => void
}

export function clampTranscriptScroll(rows: number, maxScrollRows: number): number {
  return Math.max(0, Math.min(Math.max(0, Math.floor(maxScrollRows)), Math.floor(rows)))
}

export function getTranscriptViewportWindow(
  contentRows: number,
  viewportRows: number,
  scrollRowsFromBottom: number,
): TranscriptViewportWindow {
  const normalizedContentRows = Math.max(0, Math.floor(contentRows))
  const normalizedViewportRows = Math.max(1, Math.floor(viewportRows))
  const maxScrollRows = Math.max(0, normalizedContentRows - normalizedViewportRows)
  const normalizedScrollRows = clampTranscriptScroll(scrollRowsFromBottom, maxScrollRows)
  const topRow = maxScrollRows - normalizedScrollRows

  return {
    contentRows: normalizedContentRows,
    viewportRows: normalizedViewportRows,
    maxScrollRows,
    scrollRowsFromBottom: normalizedScrollRows,
    topRow,
    bottomRow: Math.min(normalizedContentRows, topRow + normalizedViewportRows),
  }
}

export function preserveTranscriptAnchor(
  scrollRowsFromBottom: number,
  previousMaxScrollRows: number,
  nextMaxScrollRows: number,
): number {
  if (scrollRowsFromBottom <= 0) return 0
  return clampTranscriptScroll(
    scrollRowsFromBottom + nextMaxScrollRows - previousMaxScrollRows,
    nextMaxScrollRows,
  )
}

export function getTranscriptPageRows(viewportRows: number): number {
  return Math.max(1, Math.floor(Math.max(1, viewportRows) / 2))
}

export function revealTranscriptRange(
  scrollRowsFromBottom: number,
  maxScrollRows: number,
  viewportRows: number,
  rangeTop: number,
  rangeHeight: number,
): number {
  const current = getTranscriptViewportWindow(maxScrollRows + viewportRows, viewportRows, scrollRowsFromBottom)
  const normalizedTop = Math.max(0, Math.floor(rangeTop))
  const normalizedBottom = normalizedTop + Math.max(1, Math.floor(rangeHeight))

  if (normalizedTop < current.topRow) {
    return clampTranscriptScroll(maxScrollRows - normalizedTop, maxScrollRows)
  }
  if (normalizedBottom > current.bottomRow) {
    const nextTop = normalizedBottom - current.viewportRows
    return clampTranscriptScroll(maxScrollRows - nextTop, maxScrollRows)
  }
  return current.scrollRowsFromBottom
}

export function TranscriptViewport({
  children,
  scrollRowsFromBottom,
  onScrollRowsChange,
  onMetricsChange,
}: TranscriptViewportProps) {
  const viewportRef = useRef<DOMElement>(null)
  const contentRef = useRef<DOMElement>(null)
  const viewportMetrics = useBoxMetrics(viewportRef)
  const contentMetrics = useBoxMetrics(contentRef)
  const previousMaxScrollRowsRef = useRef(0)
  const lastMetricsRef = useRef<TranscriptViewportMetrics | null>(null)

  const measuredViewportRows = Math.max(1, viewportMetrics.height)
  const measuredContentRows = Math.max(0, contentMetrics.height)
  const measuredMaxScrollRows = Math.max(0, measuredContentRows - measuredViewportRows)
  const anchoredScrollRows = preserveTranscriptAnchor(
    scrollRowsFromBottom,
    previousMaxScrollRowsRef.current,
    measuredMaxScrollRows,
  )
  const window = getTranscriptViewportWindow(
    measuredContentRows,
    measuredViewportRows,
    anchoredScrollRows,
  )
  const metrics = useMemo<TranscriptViewportMetrics>(() => ({
    contentRows: window.contentRows,
    viewportRows: window.viewportRows,
    maxScrollRows: window.maxScrollRows,
  }), [window.contentRows, window.viewportRows, window.maxScrollRows])

  useEffect(() => {
    previousMaxScrollRowsRef.current = window.maxScrollRows
    if (window.scrollRowsFromBottom !== scrollRowsFromBottom) {
      onScrollRowsChange(window.scrollRowsFromBottom)
    }

    const previous = lastMetricsRef.current
    if (!previous ||
      previous.contentRows !== metrics.contentRows ||
      previous.viewportRows !== metrics.viewportRows ||
      previous.maxScrollRows !== metrics.maxScrollRows) {
      lastMetricsRef.current = metrics
      onMetricsChange(metrics)
    }
  }, [metrics, onMetricsChange, onScrollRowsChange, scrollRowsFromBottom, window.maxScrollRows, window.scrollRowsFromBottom])

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      flexBasis={0}
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflowY="hidden"
    >
      <Box
        ref={contentRef}
        flexDirection="column"
        flexShrink={0}
        position="relative"
        top={-window.topRow}
      >
        {children}
      </Box>
    </Box>
  )
}
