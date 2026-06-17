import chalk from 'chalk'
import type { Theme } from './types'

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export function resolveColor(theme: Theme, key: keyof Theme): (text: string) => string {
  const hex = theme[key]
  if (chalk.level >= 3) {
    const [r, g, b] = hexToRgb(hex)
    return (text: string) => chalk.rgb(r, g, b)(text)
  }
  if (chalk.level >= 2) {
    return (text: string) => chalk.hex(hex)(text)
  }
  return (text: string) => text
}

export function resolveBgColor(theme: Theme, key: keyof Theme): (text: string) => string {
  const hex = theme[key]
  if (chalk.level >= 3) {
    const [r, g, b] = hexToRgb(hex)
    return (text: string) => chalk.bgRgb(r, g, b)(text)
  }
  if (chalk.level >= 2) {
    return (text: string) => chalk.bgHex(hex)(text)
  }
  return (text: string) => text
}
