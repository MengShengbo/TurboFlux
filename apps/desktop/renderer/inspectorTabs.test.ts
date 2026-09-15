import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_TAB_MAXIMUM_WIDTH,
  INSPECTOR_TAB_MINIMUM_WIDTH,
  INSPECTOR_TAB_SELECTED_MINIMUM_WIDTH,
  adjacentInspectorTabId,
  inspectorTabLayout,
  reorderInspectorTabIds,
} from './inspectorTabs'

describe('Codex-style inspector tab strip', () => {
  it('uses the production tab width bounds', () => {
    expect(inspectorTabLayout(['a'], 'a', 500)[0]?.width).toBe(INSPECTOR_TAB_MAXIMUM_WIDTH)
    expect(inspectorTabLayout(['a', 'b', 'c', 'd', 'e', 'f'], null, 240).every(item => item.width === INSPECTOR_TAB_MINIMUM_WIDTH)).toBe(true)
  })

  it('keeps the active tab readable when the strip compresses', () => {
    const layout = inspectorTabLayout(['a', 'b', 'c', 'd', 'e'], 'c', 300)
    expect(layout.find(item => item.id === 'c')?.width).toBe(INSPECTOR_TAB_SELECTED_MINIMUM_WIDTH)
    expect(layout.find(item => item.id === 'a')?.showsTitle).toBe(false)
  })

  it('selects the next tab and then the previous tab on close', () => {
    expect(adjacentInspectorTabId(['a', 'b', 'c'], 'b')).toBe('c')
    expect(adjacentInspectorTabId(['a', 'b'], 'b')).toBe('a')
    expect(adjacentInspectorTabId(['a'], 'a')).toBeNull()
  })

  it('reorders tabs without losing their identity', () => {
    expect(reorderInspectorTabIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(reorderInspectorTabIds(['a', 'b', 'c'], 'missing', 'c')).toEqual(['a', 'b', 'c'])
  })
})
