import React, { createContext, useContext } from 'react'
import type { Theme, ThemeName } from './types'
import { darkTheme } from './dark'
import { lightTheme } from './light'

const themes: Record<ThemeName, Theme> = { dark: darkTheme, light: lightTheme }

const ThemeContext = createContext<Theme>(darkTheme)

export function ThemeProvider({ theme = 'dark', transparentBackground = false, children }: { theme?: ThemeName; transparentBackground?: boolean; children: React.ReactNode }) {
  const base = themes[theme]
  const value = transparentBackground
    ? {
      ...base,
      transparentBackground: true,
      divider: theme === 'dark' ? '#707070' : base.divider,
      subtle: theme === 'dark' ? '#8A8A8A' : base.subtle,
      promptBorder: base.promptBorder,
    }
    : base
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

export function getTheme(name: ThemeName): Theme {
  return themes[name]
}
