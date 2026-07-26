import { describe, expect, it } from 'vitest'
import { resolveCockpitLayout } from './CockpitRails'

describe('cockpit layout', () => {
  it('opens a restrained information sidebar on wide terminals', () => {
    expect(resolveCockpitLayout(140)).toEqual({
      showSidebar: true,
      sidebarWidth: 28,
      contentWidth: 110,
    })
  })

  it('preserves at least 64 columns for the conversation', () => {
    expect(resolveCockpitLayout(108)).toMatchObject({ showSidebar: true, sidebarWidth: 28, contentWidth: 78 })
    expect(resolveCockpitLayout(170)).toMatchObject({ showSidebar: true, sidebarWidth: 34, contentWidth: 134 })
  })

  it('protects the conversation on narrow terminals', () => {
    expect(resolveCockpitLayout(107)).toEqual({ showSidebar: false, sidebarWidth: 0, contentWidth: 105 })
    expect(resolveCockpitLayout(88)).toEqual({ showSidebar: false, sidebarWidth: 0, contentWidth: 86 })
  })
})
