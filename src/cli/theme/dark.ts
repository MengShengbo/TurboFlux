import type { Theme } from './types'
import { TURBOFLUX_ACCENTS } from './palette'

export const darkTheme: Theme = {
  transparentBackground: false,
  brand: TURBOFLUX_ACCENTS.cyanBright,
  brandShimmer: TURBOFLUX_ACCENTS.neonGreen,

  success: '#5EEA7D',
  error: '#ff4d6d',
  warning: '#ffd166',
  info: TURBOFLUX_ACCENTS.cyan,

  text: '#F1F1F1',
  inactive: '#999999',
  subtle: '#626262',

  background: '#050505',
  panelBackground: '#0a0a0a',
  panelRaised: '#141414',
  surface: '#1d1d1d',
  divider: '#303030',

  diffAdded: '#0d2b18',
  diffRemoved: '#2b1118',
  diffAddedWord: '#63ff7b',
  diffRemovedWord: '#ff708a',

  promptBorder: '#000000',
  promptBackground: '#000000',
  statusLine: '#B6B6B6',
  codeBackground: '#111111',
}
