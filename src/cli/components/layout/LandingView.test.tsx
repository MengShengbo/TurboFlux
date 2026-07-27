import React from 'react'
import { Box, Text, renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { LandingView } from './LandingView'
import { PromptInput } from '../input/PromptInput'
import '../../commands/index'
import { I18nProvider } from '../../i18n/index'

describe('LandingView', () => {
  it('centers the brand and prompt without rendering session chrome', () => {
    const output = renderToString(
      <ThemeProvider>
        <I18nProvider locale="zh-CN">
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
        </I18nProvider>
      </ThemeProvider>,
      { columns: 120 },
    )

    const lines = output.split('\n')
    const brandRow = lines.findIndex(line => line.includes('TurboFlux'))
    const promptRow = lines.findIndex(line => line.includes('我们该构建什么？'))
    expect(lines).toHaveLength(36)
    expect(brandRow).toBeGreaterThan(4)
    expect(promptRow).toBeGreaterThan(brandRow)
    expect(output).toContain('我们该构建什么？')
    expect(output).toContain('工作区 C:/workspace/turboflux')
    expect(output).not.toContain('STATUS')
    expect(lines.every(line => line.length <= 120)).toBe(true)
  })

  it('keeps the landing prompt visible when slash completions expand', () => {
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
            prompt={(
              <PromptInput
                value="/resume"
                onChange={() => {}}
                onSubmit={() => {}}
                width={76}
                appearance="landing"
              />
            )}
          />
        </Box>
      </ThemeProvider>,
      { columns: 120 },
    )

    expect(output.match(/\/resume/g)?.length).toBeGreaterThanOrEqual(2)
    expect(output.split('\n')).toHaveLength(36)
  })
})
