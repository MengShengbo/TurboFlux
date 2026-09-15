export const TERMINAL_PANEL_DEFAULT_HEIGHT = 280
export const TERMINAL_PANEL_MINIMUM_HEIGHT = 160
export const TERMINAL_PANEL_REMAINING_CONTENT_HEIGHT = 170

export function maximumTerminalPanelHeight(containerHeight: number): number {
  return Math.max(TERMINAL_PANEL_MINIMUM_HEIGHT, Math.round(containerHeight) - TERMINAL_PANEL_REMAINING_CONTENT_HEIGHT)
}

export function clampTerminalPanelHeight(height: number, containerHeight: number): number {
  const maximum = maximumTerminalPanelHeight(containerHeight)
  return Math.min(maximum, Math.max(TERMINAL_PANEL_MINIMUM_HEIGHT, Math.round(height)))
}

export function terminalPanelHeightFromPointer(
  startHeight: number,
  startPointerY: number,
  pointerY: number,
  containerHeight: number,
): number {
  return clampTerminalPanelHeight(startHeight + startPointerY - pointerY, containerHeight)
}

export function terminalPanelHeightFromKey(
  currentHeight: number,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
  containerHeight: number,
): number {
  if (key === 'Home') return TERMINAL_PANEL_MINIMUM_HEIGHT
  if (key === 'End') return maximumTerminalPanelHeight(containerHeight)
  return clampTerminalPanelHeight(currentHeight + (key === 'ArrowUp' ? 20 : -20), containerHeight)
}
