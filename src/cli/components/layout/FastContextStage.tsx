import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import type { FastContextScanEvent } from '../../../core/fastContextTypes'
import { useTheme } from '../../theme/index'
import { SPINNER_CHARS, SPINNER_INTERVAL_MS } from '../spinner/constants'
import type { FastContextUiSummary } from './fastContextUi'
import {
  isFastContextTerminalPhase,
  projectFastContextStage,
  type FastContextTraceTone,
} from './fastContextStageModel'
import { useI18n } from '../../i18n/index'

const TYPEWRITER_INTERVAL_MS = 36

interface FastContextStageProps {
  events: readonly FastContextScanEvent[]
  summary: FastContextUiSummary
  isActive: boolean
  width: number
}

export function FastContextStage({ events, summary, isActive, width }: FastContextStageProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const [tick, setTick] = useState(0)
  const model = useMemo(() => projectFastContextStage(events, summary, 10, t), [events, summary, t])
  const title = t('ui.fastContext.title')
  const stages = [
    t('ui.fastContext.stage.map'),
    t('ui.fastContext.stage.read'),
    t('ui.fastContext.stage.rank'),
    t('ui.fastContext.stage.synth'),
  ]
  const visible = isActive || isFastContextTerminalPhase(model.phase)
  const contentWidth = Math.max(12, width - 4)

  useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => setTick(value => value + 1), SPINNER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isActive])

  if (!visible) return <Box flexGrow={1} />

  const phaseColor = model.phase === 'completed' ? theme.success
    : model.phase === 'error' ? theme.error
    : model.phase === 'cancelled' ? theme.warning
    : theme.info
  const wave = model.maxWaves > 0 ? `${model.wave || 1}/${model.maxWaves}` : `${model.wave || 1}/?`

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} marginTop={1} overflow="hidden">
      <Text color={theme.divider}>{'-'.repeat(contentWidth)}</Text>
      <Box>
        {isActive && <Text color={theme.brand}>{SPINNER_CHARS[tick % SPINNER_CHARS.length]} </Text>}
        {isActive
          ? <TypewriterTitle text={title} />
          : <Text color={theme.brand} bold>{title}</Text>}
      </Box>
      <Text color={phaseColor} bold>{model.phaseLabel}</Text>

      <Box>
        {stages.map((stage, index) => (
          <React.Fragment key={stage}>
            {index > 0 && <Text color={theme.subtle}>{' > '}</Text>}
            <Text
              bold={index === model.stageIndex}
              color={index < model.stageIndex ? theme.success : index === model.stageIndex ? theme.info : theme.subtle}
            >
              {stage}
            </Text>
          </React.Fragment>
        ))}
      </Box>

      <Text color={theme.inactive}>{cliTruncate(t('ui.fastContext.metrics', { wave, files: model.files, absorbed: model.absorbed, hits: model.hits }), contentWidth)}</Text>

      {!isActive && model.phase === 'completed' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.success} bold>{t('ui.fastContext.handoff')}</Text>
          <Text color={theme.inactive}>{cliTruncate(t('ui.fastContext.ready', { files: model.absorbed, ranges: model.hits }), contentWidth)}</Text>
        </Box>
      )}
      {!isActive && model.phase === 'cancelled' && <Text color={theme.warning}>{t('ui.fastContext.cancelled')}</Text>}
      {!isActive && model.phase === 'error' && <Text color={theme.error}>{t('ui.fastContext.failed')}</Text>}

      {isActive && model.activeWorkers.slice(0, 2).map((worker, index) => (
        <Box key={worker.id} flexDirection="column">
          <Text color={theme.info}>
            {SPINNER_CHARS[(tick + index * 2) % SPINNER_CHARS.length]} {cliTruncate(worker.label, Math.max(8, contentWidth - 2))}
          </Text>
          {worker.currentPath && <Text color={theme.inactive}>{cliTruncate(`  ${worker.currentPath}`, contentWidth, { position: 'middle' })}</Text>}
        </Box>
      ))}

      {model.currentTarget && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle}>{t('ui.fastContext.currentTarget')}</Text>
          <Text color={theme.text}>{cliTruncate(model.currentTarget, contentWidth, { position: 'middle' })}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1} flexShrink={1} overflow="hidden">
        <Text color={theme.subtle}>{t('ui.fastContext.flowTrace')}</Text>
        {model.trace.slice(-8).map((entry, index, entries) => (
          <Text key={entry.id} color={traceColor(entry.tone, theme)}>
            {cliTruncate(`${index === entries.length - 1 && isActive ? '>' : '|'} ${entry.label}  ${entry.detail}`, contentWidth, { position: 'middle' })}
          </Text>
        ))}
      </Box>

    </Box>
  )
}

function TypewriterTitle({ text }: { text: string }) {
  const theme = useTheme()
  const [visibleCharacters, setVisibleCharacters] = useState(1)

  useEffect(() => {
    const timer = setInterval(() => {
      setVisibleCharacters(current => {
        if (current >= text.length) {
          clearInterval(timer)
          return current
        }
        return current + 1
      })
    }, TYPEWRITER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [text])

  return <Text color={theme.brand} bold>{text.slice(0, visibleCharacters)}</Text>
}

function traceColor(tone: FastContextTraceTone, theme: ReturnType<typeof useTheme>): string {
  if (tone === 'success') return theme.success
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  if (tone === 'muted') return theme.inactive
  return theme.info
}
