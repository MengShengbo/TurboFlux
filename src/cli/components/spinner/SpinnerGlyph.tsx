import React, { useState, useEffect, useRef } from 'react'
import { Text } from 'ink'
import { useTheme } from '../../theme/index'
import { SPINNER_CHARS, SPINNER_INTERVAL_MS, STALL_THRESHOLD_MS, STALL_TRANSITION_MS } from './constants'

interface SpinnerGlyphProps {
  lastActivity?: number
  label?: string
}

export function SpinnerGlyph({ lastActivity, label }: SpinnerGlyphProps) {
  const theme = useTheme()
  const [frame, setFrame] = useState(0)
  const [stallIntensity, setStallIntensity] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_CHARS.length)

      if (lastActivity) {
        const elapsed = Date.now() - lastActivity
        if (elapsed > STALL_THRESHOLD_MS) {
          const progress = Math.min(1, (elapsed - STALL_THRESHOLD_MS) / STALL_TRANSITION_MS)
          setStallIntensity(progress)
        } else {
          setStallIntensity(0)
        }
      }
    }, SPINNER_INTERVAL_MS)

    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [lastActivity])

  const char = SPINNER_CHARS[frame]
  const color = stallIntensity > 0 ? lerpHex(theme.brand, theme.inactive, stallIntensity) : theme.brand

  return (
    <Text>
      <Text color={color}>{char}</Text>
      {label && <Text color={theme.inactive}> {label}</Text>}
    </Text>
  )
}

function lerpHex(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const c = h.replace('#', '')
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]
  }
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const lerp = (s: number, e: number) => Math.round(s + (e - s) * t)
  const r = lerp(r1, r2).toString(16).padStart(2, '0')
  const g = lerp(g1, g2).toString(16).padStart(2, '0')
  const bl = lerp(b1, b2).toString(16).padStart(2, '0')
  return `#${r}${g}${bl}`
}
