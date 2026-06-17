import React, { createContext, useContext } from 'react'
import type { Theme, ThemeName } from './types'
import { darkTheme } from './dark'
import { lightTheme } from './light'

const themes: Record<ThemeName, Theme> = { dark: darkTheme, light: lightTheme }

const ThemeContext = createContext<Theme>(darkTheme)

export function ThemeProvider({ theme = 'dark', children }: { theme?: ThemeName; children: React.ReactNode }) {
  return <ThemeContext.Provider value={themes[theme]}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

export function getTheme(name: ThemeName): Theme {
  return themes[name]
}
