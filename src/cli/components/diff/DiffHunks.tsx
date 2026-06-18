import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import type { DiffHunk, DiffLine } from '../../../core/diffCompute'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'

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
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const nodes: React.ReactNode[] = []
  let totalRows = 0
  let renderedRows = 0
  const lineNumberWidth = getLineNumberWidth(hunks)
  const gutterWidth = lineNumberWidth * 2 + 5
  const textWidth = Math.max(24, columns - gutterWidth - 10)
  const resolvedAddedColor = addedColor === 'green' ? theme.diffAddedWord : addedColor
  const resolvedRemovedColor = removedColor === 'red' ? theme.diffRemovedWord : removedColor
  const resolvedContextColor = contextColor ?? theme.inactive

  for (let i = 0; i < hunks.length; i += 1) {
    const hunk = hunks[i]!
    totalRows += 1 + hunk.lines.length
    const remainingRows = maxLines - renderedRows
    if (remainingRows <= 0) continue

    const visibleLines = hunk.lines.slice(0, Math.max(0, remainingRows - 1))
    nodes.push(
      <Box key={`${i}-header`} marginTop={i > 0 ? 1 : 0}>
        <Text color={theme.subtle}>
          {`${' '.repeat(lineNumberWidth)} ${' '.repeat(lineNumberWidth)}   @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
        </Text>
      </Box>,
    )
    renderedRows += 1
    for (let j = 0; j < visibleLines.length; j += 1) {
      nodes.push(
        <DiffLineRow
          key={`${i}-${j}`}
          line={visibleLines[j]!}
          lineNumberWidth={lineNumberWidth}
          textWidth={textWidth}
          addedColor={resolvedAddedColor}
          removedColor={resolvedRemovedColor}
          contextColor={resolvedContextColor}
          addedBackground={theme.diffAdded}
          removedBackground={theme.diffRemoved}
          gutterColor={theme.subtle}
        />,
      )
    }
    renderedRows += visibleLines.length
  }

  return (
    <>
      {nodes}
      {totalRows > renderedRows && (
        <Text color={theme.inactive}>
          {`  ... ${totalRows - renderedRows} more diff lines hidden`}
        </Text>
      )}
    </>
  )
}

function DiffLineRow({
  line,
  lineNumberWidth,
  textWidth,
  addedColor,
  removedColor,
  contextColor,
  addedBackground,
  removedBackground,
  gutterColor,
}: {
  line: DiffLine
  lineNumberWidth: number
  textWidth: number
  addedColor: string
  removedColor: string
  contextColor: string
  addedBackground: string
  removedBackground: string
  gutterColor: string
}) {
  const oldNumber = formatLineNumber(line.oldLine, lineNumberWidth)
  const newNumber = formatLineNumber(line.newLine, lineNumberWidth)
  const visibleText = cliTruncate(line.text, textWidth, { position: 'end' })

  if (line.kind === 'add') {
    return (
      <Box backgroundColor={addedBackground}>
        <Text color={gutterColor}>{oldNumber} {newNumber} </Text>
        <Text color={addedColor} bold>+ </Text>
        <Text color={addedColor}>{visibleText}</Text>
      </Box>
    )
  }

  if (line.kind === 'remove') {
    return (
      <Box backgroundColor={removedBackground}>
        <Text color={gutterColor}>{oldNumber} {newNumber} </Text>
        <Text color={removedColor} bold>- </Text>
        <Text color={removedColor}>{visibleText}</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text color={gutterColor}>{oldNumber} {newNumber} </Text>
      <Text color={contextColor}>  </Text>
      <Text color={contextColor}>{visibleText}</Text>
    </Box>
  )
}

function getLineNumberWidth(hunks: DiffHunk[]): number {
  let maxLine = 0
  for (const hunk of hunks) {
    maxLine = Math.max(
      maxLine,
      hunk.oldStart + Math.max(0, hunk.oldLines - 1),
      hunk.newStart + Math.max(0, hunk.newLines - 1),
    )
  }
  return Math.max(2, String(maxLine).length)
}

function formatLineNumber(value: number | undefined, width: number): string {
  return value === undefined ? ' '.repeat(width) : String(value).padStart(width, ' ')
}
