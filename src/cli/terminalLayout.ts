export function getSafeFrameWidth(columns: number, reserveColumns = 4, minWidth = 20): number {
  const terminalColumns = Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 80
  const reserved = Math.max(1, Math.floor(reserveColumns))
  const maxSafeWidth = Math.max(1, terminalColumns - reserved)
  const preferred = Math.max(minWidth, maxSafeWidth)

  return Math.min(preferred, maxSafeWidth)
}

export function getSafeViewportWidth(columns: number): number {
  const terminalColumns = Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 80

  return Math.max(1, terminalColumns - 1)
}
