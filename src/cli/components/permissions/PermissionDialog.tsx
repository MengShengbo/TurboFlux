import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../../theme/index'

export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'

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
  const [decided, setDecided] = useState(false)

  useInput(useCallback((ch: string) => {
    if (decided) return
    if (ch === 'y' || ch === 'Y') {
      setDecided(true)
      onDecision('allow-once')
    } else if (ch === 'a' || ch === 'A') {
      setDecided(true)
      onDecision('allow-session')
    } else if (ch === 'n' || ch === 'N') {
      setDecided(true)
      onDecision('deny')
    }
  }, [decided, onDecision]), { isActive: isInteractive })

  if (decided) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={2} marginY={1}>
      <Text bold color={theme.brand}>Approval required</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Tool: <Text bold>{toolName}</Text></Text>
        {path && <Text>Target: <Text color={theme.brand}>{path}</Text></Text>}
        <Text dimColor>{description}</Text>
        {command && <Text>Command: <Text color={theme.brand}>{command}</Text></Text>}
      </Box>
      <Box marginTop={1}>
        <Text color="green">[y]</Text><Text> allow once  </Text>
        <Text color="cyan">[a]</Text><Text> allow for session  </Text>
        <Text color="red">[n]</Text><Text> deny</Text>
      </Box>
    </Box>
  )
}
