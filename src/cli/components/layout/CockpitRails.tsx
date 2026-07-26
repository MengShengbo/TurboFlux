export interface CockpitLayout {
  showSidebar: boolean
  sidebarWidth: number
  contentWidth: number
}

export function resolveCockpitLayout(columns: number): CockpitLayout {
  const innerWidth = Math.max(24, columns - 2)
  if (columns < 108) {
    return { showSidebar: false, sidebarWidth: 0, contentWidth: innerWidth }
  }

  const sidebarWidth = Math.max(28, Math.min(34, Math.floor(columns * 0.2)))
  return {
    showSidebar: true,
    sidebarWidth,
    contentWidth: Math.max(64, innerWidth - sidebarWidth),
  }
}
