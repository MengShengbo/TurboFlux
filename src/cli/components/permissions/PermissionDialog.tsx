import React, { useCallback, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import figures from 'figures'
import { useTheme } from '../../theme/index'

export type PermissionDecision = 'allow-once' | 'allow-run' | 'allow-session' | 'deny'

export const PERMISSION_OPTIONS: Array<{
  decision: PermissionDecision
  label: string
  description: string
}> = [
  { decision: 'allow-once', label: 'Allow once', description: 'Approve only this request' },
  { decision: 'allow-run', label: 'Allow for this run', description: 'Approve matching actions until this task ends' },
  { decision: 'allow-session', label: 'Allow for this session', description: 'Remember matching requests until exit' },
  { decision: 'deny', label: 'Deny', description: 'Block this request and return to the agent' },
]

export function getNextPermissionIndex(current: number, direction: -1 | 1): number {
  return (current + direction + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length
}

export function getPermissionDecision(index: number): PermissionDecision {
  return PERMISSION_OPTIONS[index]?.decision ?? 'deny'
}

interface PermissionDialogProps {
  toolName: string
  description: string
  command?: string
  path?: string
  onDecision: (decision: PermissionDecision) => void
}

export function PermissionDialog({ toolName, description, command, path, onDecision }: PermissionDialogProps) {
  const theme = useTheme()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [selected, setSelected] = useState(0)
  const [decided, setDecided] = useState(false)
  const decidedRef = useRef(false)

  const finish = useCallback((decision: PermissionDecision) => {
    if (decidedRef.current) return
    decidedRef.current = true
    setDecided(true)
    onDecision(decision)
  }, [onDecision])

  useInput(useCallback((ch: string, key) => {
    if (decidedRef.current) return
    if (key.escape) {
      finish('deny')
      return
    }
    if (key.return) {
      finish(getPermissionDecision(selected))
      return
    }
    if (ch === '1' || ch.toLowerCase() === 'y') {
      finish('allow-once')
      return
    }
    if (ch === '2') {
      finish('allow-run')
      return
    }
    if (ch === '3' || ch.toLowerCase() === 'a' || ch.toLowerCase() === 's') {
      finish('allow-session')
      return
    }
    if (ch === '4' || ch.toLowerCase() === 'n') {
      finish('deny')
      return
    }
    if (key.upArrow || key.leftArrow || (key.tab && key.shift)) {
      setSelected(current => getNextPermissionIndex(current, -1))
      return
    }
    if (key.downArrow || key.rightArrow || key.tab) {
      setSelected(current => getNextPermissionIndex(current, 1))
    }
  }, [finish, selected]), { isActive: isInteractive })

  if (decided) return null

  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="single" borderColor={theme.warning} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.warning}>Permission request</Text>
        <Text color={theme.inactive}>REVIEW</Text>
      </Box>
      <Box flexDirection="column">
        <Text color={theme.inactive}>Tool    <Text color={theme.text} bold>{toolName}</Text></Text>
        {path && <Text color={theme.inactive}>Target  <Text color={theme.brand}>{path}</Text></Text>}
        <Text color={theme.inactive}>Reason  <Text color={theme.text}>{description}</Text></Text>
        {command && (
          <Box paddingX={1} backgroundColor={theme.codeBackground}>
            <Text color={theme.brand} wrap="truncate-end">{command}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_OPTIONS.map((option, index) => {
          const isSelected = index === selected
          const selectedColor = option.decision === 'deny' ? theme.error : theme.brandShimmer
          return (
            <Box key={option.decision} flexDirection="column">
              <Text color={isSelected ? selectedColor : theme.inactive} bold={isSelected}>
                {isSelected ? `${figures.pointer} ` : '  '}{index + 1}. {option.label}
              </Text>
              {isSelected && (
                <Box paddingLeft={2}>
                  <Text color={theme.inactive} wrap="truncate-end">{option.description}</Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.subtle}>1/2/3/4 choose - arrows + Enter confirm</Text>
      </Box>
    </Box>
  )
}
