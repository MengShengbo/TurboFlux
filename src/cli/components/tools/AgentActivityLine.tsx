import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { SPINNER_INTERVAL_MS } from '../spinner/constants'

interface AgentActivityLineProps {
  active: boolean
}

interface AgentActivitySegment {
  text: string
  color: string
  bold: boolean
}

const SHIMMER_STEP = 2
const BASE_COLOR = '#075985'
const SWEEP_COLORS = ['#0e7490', '#0891b2', '#22d3ee', '#67e8f9', '#22d3ee', '#0891b2', '#0e7490']

export function AgentActivityLine({ active }: AgentActivityLineProps) {
  const { columns } = useTerminalSize()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    setFrame(0)

    const interval = setInterval(() => {
      setFrame(value => (value + 1) % 1000000)
    }, SPINNER_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [active])

  if (!active) return null

  const segments = buildAgentActivityLineFrame(columns, frame)

  return (
    <Box flexShrink={0} height={1}>
      {segments.map((segment, index) => (
        <Text key={`${index}-${segment.color}-${segment.bold ? 'bold' : 'base'}`} color={segment.color} bold={segment.bold}>
          {segment.text}
        </Text>
      ))}
    </Box>
  )
}

export function buildAgentActivityLineFrame(width: number, frame: number): AgentActivitySegment[] {
  const safeWidth = Math.max(0, Math.floor(width))
  if (safeWidth === 0) return []

  const shimmerWidth = Math.max(10, Math.min(26, Math.floor(safeWidth * 0.2)))
  const travelWidth = safeWidth + shimmerWidth
  const head = positiveModulo(frame * SHIMMER_STEP, travelWidth)
  const chars: AgentActivitySegment[] = []

  for (let index = 0; index < safeWidth; index += 1) {
    const distance = head - index
    const sweepIndex = distance >= 0 && distance < shimmerWidth
      ? Math.min(SWEEP_COLORS.length - 1, Math.floor((distance / shimmerWidth) * SWEEP_COLORS.length))
      : -1
    const isCore = sweepIndex === 3
    chars.push(sweepIndex >= 0
      ? {
          text: '-',
          color: SWEEP_COLORS[sweepIndex]!,
          bold: isCore,
        }
      : {
          text: '-',
          color: BASE_COLOR,
          bold: false,
        })
  }

  return mergeSegments(chars)
}

function mergeSegments(chars: AgentActivitySegment[]): AgentActivitySegment[] {
  const segments: AgentActivitySegment[] = []

  for (const char of chars) {
    const previous = segments[segments.length - 1]
    if (previous && previous.color === char.color && previous.bold === char.bold) {
      previous.text += char.text
    } else {
      segments.push({ ...char })
    }
  }

  return segments
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}
