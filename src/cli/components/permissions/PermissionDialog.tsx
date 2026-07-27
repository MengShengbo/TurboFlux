import React, { useCallback, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import figures from 'figures'
import cliTruncate from 'cli-truncate'
import { resolveBackground, useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { createTranslator, useI18n, type Translator } from '../../i18n/index'

export type PermissionDecision = 'allow-once' | 'allow-run' | 'allow-session' | 'deny'

export function createPermissionOptions(t: Translator): Array<{
  decision: PermissionDecision
  label: string
  description: string
}> {
  return [
    { decision: 'allow-once', label: t('ui.permission.allowOnce'), description: t('ui.permission.allowOnceDescription') },
    { decision: 'allow-run', label: t('ui.permission.allowRun'), description: t('ui.permission.allowRunDescription') },
    { decision: 'allow-session', label: t('ui.permission.allowSession'), description: t('ui.permission.allowSessionDescription') },
    { decision: 'deny', label: t('ui.permission.deny'), description: t('ui.permission.denyDescription') },
  ]
}

export const PERMISSION_OPTIONS = createPermissionOptions(createTranslator('en'))

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
  const { t } = useI18n()
  const permissionOptions = createPermissionOptions(t)
  const { columns } = useTerminalSize()
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
        <Text bold color={theme.warning}>{t('ui.permission.title')}</Text>
        <Text color={theme.inactive}>{t('ui.permission.review')}</Text>
      </Box>
      <Box flexDirection="column">
        <Text color={theme.inactive}>{t('ui.permission.tool')}    <Text color={theme.text} bold>{toolName}</Text></Text>
        {path && <Text color={theme.inactive}>{t('ui.permission.target')}  <Text color={theme.brand}>{path}</Text></Text>}
        <Text color={theme.inactive}>{t('ui.permission.reason')}  <Text color={theme.text}>{description}</Text></Text>
        {command && (
          <Box paddingX={1} backgroundColor={resolveBackground(theme, 'codeBackground')}>
            <Text color={theme.brand} wrap="truncate-end">{command}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {permissionOptions.map((option, index) => {
          const isSelected = index === selected
          const selectedColor = option.decision === 'deny' ? theme.error : theme.brandShimmer
          return (
            <Box key={option.decision}>
              <Box width={28} flexShrink={0}>
                <Text color={isSelected ? selectedColor : theme.inactive} bold={isSelected}>
                  {isSelected ? `${figures.pointer} ` : '  '}{index + 1}. {option.label}
                </Text>
              </Box>
              <Text color={theme.inactive}>{cliTruncate(option.description, Math.max(12, columns - 34), { position: 'end' })}</Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.subtle}>{t('ui.permission.keys')}</Text>
      </Box>
    </Box>
  )
}
