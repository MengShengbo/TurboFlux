import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeThemePreference, resolveThemePreference } from './theme'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function darkRule(selector: string): string {
  const start = styles.indexOf(`html[data-theme="dark"] ${selector}`)
  expect(start, `missing dark theme rule for ${selector}`).toBeGreaterThanOrEqual(0)
  return styles.slice(start, styles.indexOf('}', start) + 1)
}

describe('desktop theme preference', () => {
  it('normalizes persisted values without accepting unknown themes', () => {
    expect(normalizeThemePreference('light')).toBe('light')
    expect(normalizeThemePreference('dark')).toBe('dark')
    expect(normalizeThemePreference('system')).toBe('system')
    expect(normalizeThemePreference('midnight')).toBe('system')
  })

  it('resolves the system preference while preserving explicit choices', () => {
    expect(resolveThemePreference('system', true)).toBe('dark')
    expect(resolveThemePreference('system', false)).toBe('light')
    expect(resolveThemePreference('light', true)).toBe('light')
    expect(resolveThemePreference('dark', false)).toBe('dark')
  })

  it('themes every major raised surface used by the desktop workbench', () => {
    expect(darkRule('.tool-activity {')).toContain('background: #1c1c1c')
    expect(darkRule('.visual-evidence-thumbnail {')).toContain('background: #1e1e1e')
    expect(darkRule('.artifact-preview pre {')).toContain('background: #181818')
    expect(darkRule('.model-only-menu {')).toContain('background: #1b1b1b')
  })

  it('defines dark semantic aliases used by Work panels', () => {
    const rootRule = darkRule('{')
    expect(rootRule).toContain('--muted-strong: #cecece')
    expect(rootRule).toContain('--ink: #f3f3f3')
  })

  it('preserves the neutral graphite hierarchy', () => {
    const rootRule = darkRule('{')
    expect(rootRule).toContain('--surface: #111111')
    expect(rootRule).toContain('--composer-surface: #242424')
    expect(darkRule('.sidebar {')).toContain('background: #373737')
    expect(darkRule('.main-panel,')).toContain('background: #111111')
  })

  it('renders ordinary controls with a high-contrast white foreground', () => {
    expect(darkRule('.window-sidebar-toggle {')).toContain('color: #f1f1f1')
    expect(darkRule('.sidebar-nav-item,')).toContain('color: #f1f1f1')
    expect(darkRule('.sidebar-nav-item.active .icon {')).toContain('color: #f1f1f1')
    expect(darkRule('.workspace-task-group.contains-current .workspace-task-group-toggle > .icon-workspace {')).toContain('color: #a2c4b0')
    expect(darkRule('.composer-slant-tab,')).toContain('color: #f1f1f1')
    expect(darkRule('.composer-menu-glyph,')).toContain('color: #f1f1f1')
    expect(darkRule('.inspector-tab-slot.active .inspector-tab-icon {')).toContain('color: #f1f1f1')
    expect(darkRule('.settings-nav-icon,')).toContain('color: #f1f1f1')
  })

  it('keeps ordinary activity surfaces neutral instead of teal', () => {
    expect(darkRule('.message-capabilities span {')).toContain('color: #f1f1f1')
    expect(darkRule('.message-capabilities span {')).toContain('background: #292929')
    expect(darkRule('.browser-activity-pill {')).toContain('color: #f1f1f1')
    expect(darkRule('.browser-activity-pill {')).toContain('background: #292929')
    expect(darkRule('.tool-activity.browser-activity .tool-activity-glyph {')).toContain('color: #f1f1f1')
    expect(darkRule('.tool-activity.browser-activity .tool-activity-glyph {')).toContain('background: #292929')
  })

  it('retains color for permission and status semantics', () => {
    expect(darkRule('.approval-pill[data-policy="full"] {')).toContain('color: #ff746c')
    expect(darkRule('.approval-pill[data-policy="full"] {')).toContain('background: transparent')
    expect(darkRule('.approval-pill[data-policy="full"] {')).toContain('box-shadow: none')
    expect(darkRule('.approval-menu .composer-menu-row[data-policy="full"] {')).toContain('color: #ff746c')
    expect(darkRule('.approval-menu .composer-menu-row[data-policy="full"] {')).toContain('background: transparent')
    expect(styles).not.toContain('.conversation.running time::before')
    const automationStyles = readFileSync(new URL('./automationsView.css', import.meta.url), 'utf8')
    expect(automationStyles).toContain('.av-status-completed { color: var(--success); }')
    expect(darkRule('{')).toContain('--success: #68bd8d')
  })
})
