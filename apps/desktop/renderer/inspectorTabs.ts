export const INSPECTOR_TAB_GAP = 3
export const INSPECTOR_TAB_EDGE_PADDING = 12
export const INSPECTOR_TAB_MINIMUM_WIDTH = 42
export const INSPECTOR_TAB_MAXIMUM_WIDTH = 176
export const INSPECTOR_TAB_DEFAULT_WIDTH = 132
export const INSPECTOR_TAB_SELECTED_MINIMUM_WIDTH = 70
export const INSPECTOR_TAB_TITLE_THRESHOLD = 65

export interface InspectorTabLayoutItem {
  id: string
  width: number
  showsTitle: boolean
}

export function inspectorTabLayout(
  tabIds: readonly string[],
  activeTabId: string | null,
  availableWidth: number,
): InspectorTabLayoutItem[] {
  if (tabIds.length === 0) return []
  const totalGap = INSPECTOR_TAB_GAP * Math.max(0, tabIds.length - 1)
  const usableWidth = Math.max(0, availableWidth - (INSPECTOR_TAB_EDGE_PADDING * 2) - totalGap)
  const sharedWidth = clampTabWidth(usableWidth / tabIds.length)
  const hasSelectedTab = activeTabId !== null && tabIds.includes(activeTabId)
  const selectedWidth = hasSelectedTab && sharedWidth < INSPECTOR_TAB_SELECTED_MINIMUM_WIDTH
    ? INSPECTOR_TAB_SELECTED_MINIMUM_WIDTH
    : sharedWidth
  const remainingCount = hasSelectedTab ? tabIds.length - 1 : tabIds.length
  const remainingWidth = hasSelectedTab ? usableWidth - selectedWidth : usableWidth
  const unselectedWidth = remainingCount > 0
    ? clampTabWidth(remainingWidth / remainingCount)
    : selectedWidth

  return tabIds.map(id => {
    const width = id === activeTabId ? selectedWidth : unselectedWidth
    return { id, width, showsTitle: width > INSPECTOR_TAB_TITLE_THRESHOLD }
  })
}

export function adjacentInspectorTabId(
  tabIds: readonly string[],
  closingTabId: string,
): string | null {
  const index = tabIds.indexOf(closingTabId)
  if (index === -1) return null
  return tabIds[index + 1] ?? tabIds[index - 1] ?? null
}

export function reorderInspectorTabIds(
  tabIds: readonly string[],
  movingTabId: string,
  targetTabId: string,
): string[] {
  const fromIndex = tabIds.indexOf(movingTabId)
  const targetIndex = tabIds.indexOf(targetTabId)
  if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) return [...tabIds]
  const next = [...tabIds]
  next.splice(fromIndex, 1)
  next.splice(targetIndex, 0, movingTabId)
  return next
}

function clampTabWidth(value: number): number {
  if (!Number.isFinite(value)) return INSPECTOR_TAB_DEFAULT_WIDTH
  return Math.max(INSPECTOR_TAB_MINIMUM_WIDTH, Math.min(INSPECTOR_TAB_MAXIMUM_WIDTH, value))
}
