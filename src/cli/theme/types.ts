export interface Theme {
  transparentBackground: boolean
  brand: string
  brandShimmer: string

  success: string
  error: string
  warning: string
  info: string

  text: string
  inactive: string
  subtle: string

  background: string
  panelBackground: string
  panelRaised: string
  surface: string
  divider: string

  diffAdded: string
  diffRemoved: string
  diffAddedWord: string
  diffRemovedWord: string

  promptBorder: string
  promptBackground: string
  statusLine: string
  codeBackground: string
}

export type ThemeColorKey = Exclude<keyof Theme, 'transparentBackground'>

export type ThemeName = 'dark' | 'light'
