import React from 'react'
import { Box, Text } from 'ink'
import { Header } from '../header/Header'
import type { MascotMood } from '../header/Mascot'
import { useI18n } from '../../i18n/index'
import { resolveBackground, useTheme } from '../../theme/index'

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
}: LandingViewProps) {
  const { t } = useI18n()
  const theme = useTheme()
  const landingBackground = resolveBackground(theme, 'background')
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={landingBackground}
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
      <Box width={frameWidth} flexDirection="column" alignItems="center" marginTop={2} flexShrink={0}>
        {showPrompt ? (
          <>
            <Text bold>{t('ui.landing.prompt')}</Text>
            <Box marginTop={1} backgroundColor={landingBackground}>{prompt}</Box>
          </>
        ) : null}
      </Box>
    </Box>
  )
}
