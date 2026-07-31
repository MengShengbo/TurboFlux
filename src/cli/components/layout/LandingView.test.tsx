import React from 'react'
import chalk from 'chalk'
import { Box, Text, renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { LandingView } from './LandingView'
import { PromptInput } from '../input/PromptInput'
import '../../commands/index'
import { I18nProvider } from '../../i18n/index'

describe('LandingView', () => {
  it('emits no structural background color in transparent mode', () => {
    const previousLevel = chalk.level
    chalk.level = 3
    try {
      const renderLanding = (transparentBackground: boolean) => renderToString(
        <ThemeProvider transparentBackground={transparentBackground}>
          <Box width={80} height={24}>
            <LandingView
              frameWidth={60}
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
        { columns: 80 },
      )

      expect(renderLanding(true)).not.toContain('\u001b[48;')
      expect(renderLanding(false)).toContain('\u001b[48;')
    } finally {
      chalk.level = previousLevel
    }
  })

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
    expect(output).not.toContain('Flow v2')
    expect(output).not.toContain('STATUS')
    expect(lines.every(line => line.length <= 120)).toBe(true)
  })

  it('does not expose internal Flow rollout status', () => {
    const output = renderToString(
      <ThemeProvider>
        <I18nProvider locale="en">
          <Box width={100} height={30}>
            <LandingView
              frameWidth={72}
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
      { columns: 100 },
    )

    expect(output).not.toContain('Flow v2')
    expect(output).not.toContain('Flow core')
    expect(output.split('\n')).toHaveLength(30)
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
