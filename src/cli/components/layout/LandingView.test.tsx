import React from 'react'
import { Box, Text, renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { LandingView } from './LandingView'

describe('LandingView', () => {
  it('centers the brand and prompt without rendering session chrome', () => {
    const output = renderToString(
      <ThemeProvider>
        <Box width={120} height={36}>
          <LandingView
            frameWidth={76}
            workspacePath="C:/workspace/turboflux"
            mood="idle"
            hasApiKey
            logoReveal={1}
            showVersion
            showWorkspace
            showPrompt
            prompt={<Text>{'> '}</Text>}
          />
        </Box>
      </ThemeProvider>,
      { columns: 120 },
    )

    const lines = output.split('\n')
    const brandRow = lines.findIndex(line => line.includes('TurboFlux'))
    const promptRow = lines.findIndex(line => line.includes('What should we build?'))
    expect(lines).toHaveLength(36)
    expect(brandRow).toBeGreaterThan(4)
    expect(promptRow).toBeGreaterThan(brandRow)
    expect(output).toContain('workspace C:/workspace/turboflux')
    expect(output).not.toContain('STATUS')
    expect(lines.every(line => line.length <= 120)).toBe(true)
  })
})
