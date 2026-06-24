import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { SPINNER_INTERVAL_MS } from '../spinner/constants'

interface AgentActivityLineProps {
  active: boolean
}

interface AgentActivitySegment {
  text: string
  glow: boolean
}

const SHIMMER_STEP = 2

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
        <Text key={`${index}-${segment.glow ? 'glow' : 'base'}`} color={segment.glow ? '#38bdf8' : '#075985'} bold={segment.glow}>
          {segment.text}
        </Text>
      ))}
    </Box>
  )
}

export function buildAgentActivityLineFrame(width: number, frame: number): AgentActivitySegment[] {
  const safeWidth = Math.max(0, Math.floor(width))
  if (safeWidth === 0) return []

  const shimmerWidth = Math.max(6, Math.min(18, Math.floor(safeWidth * 0.18)))
  const travelWidth = safeWidth + shimmerWidth
  const head = positiveModulo(frame * SHIMMER_STEP, travelWidth)
  const chars: AgentActivitySegment[] = []

  for (let index = 0; index < safeWidth; index += 1) {
    const distance = head - index
    const glow = distance >= 0 && distance < shimmerWidth
    chars.push({
      text: glow ? '/' : '-',
      glow,
    })
  }

  return mergeSegments(chars)
}

function mergeSegments(chars: AgentActivitySegment[]): AgentActivitySegment[] {
  const segments: AgentActivitySegment[] = []

  for (const char of chars) {
    const previous = segments[segments.length - 1]
    if (previous && previous.glow === char.glow) {
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
