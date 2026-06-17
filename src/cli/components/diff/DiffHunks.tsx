import React from 'react'
import { Box, Text } from 'ink'
import type { DiffHunk, DiffLine } from '../../../core/diffCompute'

interface DiffHunksProps {
  hunks: DiffHunk[]
  maxLines?: number
  addedColor?: string
  removedColor?: string
  contextColor?: string
}

export function DiffHunks({
  hunks,
  maxLines = 30,
  addedColor = 'green',
  removedColor = 'red',
  contextColor,
}: DiffHunksProps) {
  const nodes: React.ReactNode[] = []
  let totalRows = 0
  let renderedRows = 0

  for (let i = 0; i < hunks.length; i += 1) {
    const hunk = hunks[i]!
    totalRows += 1 + hunk.lines.length
    const remainingRows = maxLines - renderedRows
    if (remainingRows <= 0) continue

    const visibleLines = hunk.lines.slice(0, Math.max(0, remainingRows - 1))
    nodes.push(
      <Box key={`${i}-header`}>
        <Text dimColor>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</Text>
      </Box>,
    )
    renderedRows += 1
    for (let j = 0; j < visibleLines.length; j += 1) {
      nodes.push(
        <DiffLineRow
          key={`${i}-${j}`}
          line={visibleLines[j]!}
          addedColor={addedColor}
          removedColor={removedColor}
          contextColor={contextColor}
        />,
      )
    }
    renderedRows += visibleLines.length
  }

  return (
    <>
      {nodes}
      {totalRows > renderedRows && <Text dimColor>  ... ({totalRows - renderedRows} more lines)</Text>}
    </>
  )
}

function DiffLineRow({
  line,
  addedColor,
  removedColor,
  contextColor,
}: {
  line: DiffLine
  addedColor: string
  removedColor: string
  contextColor?: string
}) {
  if (line.kind === 'add') {
    return (
      <Box>
        <Text color={addedColor}>+ {line.text}</Text>
      </Box>
    )
  }

  if (line.kind === 'remove') {
    return (
      <Box>
        <Text color={removedColor}>- {line.text}</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text color={contextColor} dimColor={!contextColor}>  {line.text}</Text>
    </Box>
  )
}
