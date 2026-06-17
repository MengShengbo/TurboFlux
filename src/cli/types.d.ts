declare module 'chalk' {
  interface ChalkInstance {
    (...text: unknown[]): string
    bold: ChalkInstance
    dim: ChalkInstance
    italic: ChalkInstance
    underline: ChalkInstance
    strikethrough: ChalkInstance
    red: ChalkInstance
    green: ChalkInstance
    yellow: ChalkInstance
    blue: ChalkInstance
    cyan: ChalkInstance
    white: ChalkInstance
    gray: ChalkInstance
    magenta: ChalkInstance
    bgRed: ChalkInstance
    bgGreen: ChalkInstance
    bgYellow: ChalkInstance
    bgBlue: ChalkInstance
    bgCyan: ChalkInstance
    level: number
    rgb(r: number, g: number, b: number): ChalkInstance
    bgRgb(r: number, g: number, b: number): ChalkInstance
    hex(color: string): ChalkInstance
    bgHex(color: string): ChalkInstance
  }
  const chalk: ChalkInstance
  export default chalk
}

declare module 'commander' {
  class Command {
    name(name: string): this
    description(desc: string): this
    version(ver: string): this
    argument(name: string, desc?: string, defaultValue?: any): this
    option(flags: string, desc?: string, defaultValue?: any): this
    action(fn: (...args: any[]) => void | Promise<void>): this
    command(name: string): Command
    parse(argv?: string[]): this
  }
  export { Command }
}

declare module 'ink-text-input' {
  import { FC } from 'react'
  interface TextInputProps {
    value: string
    onChange: (value: string) => void
    onSubmit?: (value: string) => void
    placeholder?: string
  }
  const TextInput: FC<TextInputProps>
  export default TextInput
}

declare module 'strip-ansi' {
  function stripAnsi(text: string): string
  export default stripAnsi
}

declare module 'figures' {
  export const tick: string
  export const cross: string
  export const warning: string
  export const info: string
  export const circle: string
  export const ellipsis: string
  export const pointer: string
  export const bullet: string
  export const radioOn: string
  export const radioOff: string
  export const checkboxOn: string
  export const checkboxOff: string
  export const arrowRight: string
  export const arrowDown: string
  export const arrowUp: string
  export const play: string
}

declare module 'string-width' {
  function stringWidth(text: string): number
  export default stringWidth
}

declare module 'cli-truncate' {
  function cliTruncate(text: string, columns: number, options?: { position?: 'start' | 'middle' | 'end'; preferTruncationOnSpace?: boolean }): string
  export default cliTruncate
}

declare module 'highlight.js' {
  interface HighlightResult {
    value: string
    language?: string
    relevance: number
  }
  interface HighlightOptions {
    language: string
    ignoreIllegals?: boolean
  }
  function highlight(code: string, options: HighlightOptions): HighlightResult
  function highlightAuto(code: string): HighlightResult
  export default { highlight, highlightAuto }
}

declare module 'diff' {
  interface Change {
    value: string
    added?: boolean
    removed?: boolean
    count?: number
  }
  interface Hunk {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }
  interface ParsedDiff {
    oldFileName?: string
    newFileName?: string
    hunks: Hunk[]
  }
  function diffLines(oldStr: string, newStr: string): Change[]
  function diffWords(oldStr: string, newStr: string): Change[]
  function structuredPatch(oldFileName: string, newFileName: string, oldStr: string, newStr: string, oldHeader?: string, newHeader?: string, options?: any): ParsedDiff
  export { diffLines, diffWords, structuredPatch, Change, Hunk, ParsedDiff }
}
