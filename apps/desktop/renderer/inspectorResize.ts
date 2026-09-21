export const INSPECTOR_MINIMUM_WIDTH = 320
export const INSPECTOR_DISMISS_WIDTH = 160
export const INSPECTOR_REGULAR_MAIN_RESERVE = 352
export const INSPECTOR_DEFAULT_MAIN_RESERVE = 500
export const INSPECTOR_DEFAULT_MAXIMUM_WIDTH = 640
export const INSPECTOR_DEFAULT_SHELL_ASPECT = 16 / 10

export type InspectorWidthMode = 'regular' | 'full'

export function maximumInspectorWidth(mainContentWidth: number, mode: InspectorWidthMode = 'regular'): number {
  const availableWidth = Math.max(0, mainContentWidth)
  return Math.max(
    INSPECTOR_MINIMUM_WIDTH,
    mode === 'full' ? availableWidth : availableWidth - INSPECTOR_REGULAR_MAIN_RESERVE,
  )
}

export function defaultInspectorWidth(
  mainContentWidth: number,
  shellHeight = mainContentWidth / INSPECTOR_DEFAULT_SHELL_ASPECT,
): number {
  const availableWidth = Math.max(0, mainContentWidth)
  return Math.round(Math.max(
    INSPECTOR_MINIMUM_WIDTH,
    Math.min(shellHeight * INSPECTOR_DEFAULT_SHELL_ASPECT, availableWidth - INSPECTOR_DEFAULT_MAIN_RESERVE),
    Math.min(INSPECTOR_DEFAULT_MAXIMUM_WIDTH, availableWidth - INSPECTOR_REGULAR_MAIN_RESERVE),
  ))
}

export function clampInspectorWidth(value: number, mainContentWidth: number, mode: InspectorWidthMode = 'regular'): number {
  return Math.round(Math.min(
    maximumInspectorWidth(mainContentWidth, mode),
    Math.max(INSPECTOR_MINIMUM_WIDTH, value),
  ))
}

export function inspectorDismissTriggerX(panelLeft: number, panelWidth: number): number {
  return Math.round(panelLeft + panelWidth - INSPECTOR_DISMISS_WIDTH)
}

export function shouldDismissInspectorAtPointer(pointerX: number, triggerX: number): boolean {
  return pointerX >= triggerX
}

export function inspectorDragWidthMode(
  pointerX: number,
  contentLeft: number,
  contentWidth: number,
  currentMode: InspectorWidthMode,
): InspectorWidthMode {
  const reservedWidth = Math.max(0, contentWidth - maximumInspectorWidth(contentWidth))
  const midpoint = contentLeft + reservedWidth / 2
  // Separate the two thresholds so a pointer near the midpoint cannot flicker between modes.
  if (currentMode === 'regular' && pointerX < midpoint - 8) return 'full'
  if (currentMode === 'full' && pointerX > midpoint + 8) return 'regular'
  return currentMode
}

export function inspectorWidthFromKey(
  currentWidth: number,
  key: string,
  accelerated: boolean,
  mainContentWidth: number,
  mode: InspectorWidthMode = 'regular',
): number | null {
  void accelerated
  if (key === 'Home') return clampInspectorWidth(INSPECTOR_MINIMUM_WIDTH, mainContentWidth, mode)
  if (key === 'End') return maximumInspectorWidth(mainContentWidth, mode)
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const step = 10
  return clampInspectorWidth(currentWidth + (key === 'ArrowLeft' ? step : -step), mainContentWidth, mode)
}

export function inspectorWidthRatio(
  width: number,
  mainContentWidth: number,
  mode: InspectorWidthMode = 'regular',
): number {
  const maximum = maximumInspectorWidth(mainContentWidth, mode)
  const range = maximum - INSPECTOR_MINIMUM_WIDTH
  if (range <= 0) return 0
  return Math.max(0, Math.min(1, (clampInspectorWidth(width, mainContentWidth, mode) - INSPECTOR_MINIMUM_WIDTH) / range))
}

export function inspectorWidthFromRatio(
  ratio: number,
  mainContentWidth: number,
  mode: InspectorWidthMode = 'regular',
): number {
  const maximum = maximumInspectorWidth(mainContentWidth, mode)
  const normalized = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  return Math.round(INSPECTOR_MINIMUM_WIDTH + normalized * (maximum - INSPECTOR_MINIMUM_WIDTH))
}
