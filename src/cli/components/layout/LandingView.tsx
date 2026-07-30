import React from 'react'
import { Box, Text } from 'ink'
import { Header } from '../header/Header'
import type { MascotMood } from '../header/Mascot'
import { useI18n } from '../../i18n/index'

interface LandingViewProps {
  frameWidth: number
  workspacePath: string
  mood: MascotMood
  hasApiKey: boolean
  logoReveal: number
  showVersion: boolean
  showWorkspace: boolean
  showPrompt: boolean
  prompt: React.ReactNode
  flowEnabled?: boolean
}

export function LandingView({
  frameWidth,
  workspacePath,
  mood,
  hasApiKey,
  logoReveal,
  showVersion,
  showWorkspace,
  showPrompt,
  prompt,
  flowEnabled = true,
}: LandingViewProps) {
  const { t } = useI18n()
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor="#050505"
    >
      <Header
        workspacePath={workspacePath}
        mood={mood}
        hasApiKey={hasApiKey}
        width={frameWidth}
        logoReveal={logoReveal}
        showVersion={showVersion}
        showWorkspace={showWorkspace}
        showConnector
      />
      <Text color={flowEnabled ? "#76c7a1" : "#d6a85f"}>
        {showWorkspace ? t(flowEnabled ? 'ui.landing.flowReady' : 'ui.landing.flowFallback') : ' '}
      </Text>
      <Box width={frameWidth} flexDirection="column" alignItems="center" marginTop={2} flexShrink={0}>
        {showPrompt ? (
          <>
            <Text bold>{t('ui.landing.prompt')}</Text>
            <Box marginTop={1} backgroundColor="#050505">{prompt}</Box>
          </>
        ) : null}
      </Box>
    </Box>
  )
}
