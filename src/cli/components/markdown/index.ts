import chalk from 'chalk'
import { highlightCode } from './highlighter'

const CODE_BLOCK_RE = /```(\w+)?\n([\s\S]*?)```/g
const INLINE_CODE_RE = /`([^`]+)`/g
const BOLD_RE = /\*\*([^*]+)\*\*/g
const ITALIC_RE = /(?<!\*)\*([^*]+)\*(?!\*)/g
const H1_RE = /^# (.+)$/gm
const H2_RE = /^## (.+)$/gm
const H3_RE = /^### (.+)$/gm
const BULLET_RE = /^(\s*)[*\-]\s+(.+)$/gm
const NUMBERED_RE = /^(\s*)\d+\.\s+(.+)$/gm
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const HR_RE = /^---+$/gm

const MAX_CACHE_ENTRIES = 512
const MAX_CACHE_BYTES = 4 * 1024 * 1024
export const MAX_DISPLAY_MARKDOWN_CHARS = 64 * 1024

interface MarkdownCacheEntry {
  formatted: string
  bytes: number
}

export interface MarkdownCacheStats {
  hits: number
  misses: number
  evictions: number
  entries: number
  bytes: number
  hitRate: number
}

const markdownCache = new Map<string, MarkdownCacheEntry>()
let markdownCacheBytes = 0
let markdownCacheHits = 0
let markdownCacheMisses = 0
let markdownCacheEvictions = 0

export function formatMarkdown(text: string): string {
  if (!text) return ''

  const cached = markdownCache.get(text)
  if (cached) {
    markdownCacheHits += 1
    markdownCache.delete(text)
    markdownCache.set(text, cached)
    return cached.formatted
  }
  markdownCacheMisses += 1

  const formatted = text
    .replace(CODE_BLOCK_RE, (_match, lang, code) => {
      const langLabel = lang || 'code'
      const highlighted = highlightCode(code.trimEnd(), lang)
      const lines = highlighted.split('\n')
      const header = chalk.dim(`  +-- ${langLabel} ${'-'.repeat(Math.max(1, 34 - langLabel.length))}`)
      const body = lines.map(l => chalk.dim('  | ') + l).join('\n')
      const footer = chalk.dim(`  +${'-'.repeat(40)}`)
      return `${header}\n${body}\n${footer}`
    })
    .replace(INLINE_CODE_RE, (_m, code) => chalk.cyan(code))
    .replace(BOLD_RE, (_m, t) => chalk.bold(t))
    .replace(ITALIC_RE, (_m, t) => chalk.italic(t))
    .replace(H1_RE, (_m, t) => chalk.bold.underline(t))
    .replace(H2_RE, (_m, t) => chalk.bold(t))
    .replace(H3_RE, (_m, t) => chalk.dim.bold(t))
    .replace(BULLET_RE, (_m, indent, t) => `${indent}${chalk.dim('-')} ${t}`)
    .replace(NUMBERED_RE, (_m, indent, t) => `${indent}${chalk.dim('-')} ${t}`)
    .replace(LINK_RE, (_m, label, url) => `${chalk.underline(label)} ${chalk.dim(`(${url})`)}`)
    .replace(HR_RE, () => chalk.dim('-'.repeat(40)))

  const bytes = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(formatted, 'utf8')
  if (bytes <= MAX_CACHE_BYTES) {
    markdownCache.set(text, { formatted, bytes })
    markdownCacheBytes += bytes
    while (markdownCache.size > MAX_CACHE_ENTRIES || markdownCacheBytes > MAX_CACHE_BYTES) {
      const oldestKey = markdownCache.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = markdownCache.get(oldestKey)
      markdownCache.delete(oldestKey)
      markdownCacheBytes -= oldest?.bytes ?? 0
      markdownCacheEvictions += 1
    }
  }
  return formatted
}

export function formatMarkdownForDisplay(text: string, maxChars = MAX_DISPLAY_MARKDOWN_CHARS): string {
  if (!text) return ''
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return formatMarkdown(text)
  const visible = text.slice(0, limit)
  return `${formatMarkdown(visible)}\n\n[display truncated after ${limit.toLocaleString()} characters]`
}

export function getMarkdownCacheStats(): MarkdownCacheStats {
  const total = markdownCacheHits + markdownCacheMisses
  return {
    hits: markdownCacheHits,
    misses: markdownCacheMisses,
    evictions: markdownCacheEvictions,
    entries: markdownCache.size,
    bytes: markdownCacheBytes,
    hitRate: total === 0 ? 0 : markdownCacheHits / total,
  }
}

export function resetMarkdownCache(): void {
  markdownCache.clear()
  markdownCacheBytes = 0
  markdownCacheHits = 0
  markdownCacheMisses = 0
  markdownCacheEvictions = 0
}
