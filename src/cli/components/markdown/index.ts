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

export function formatMarkdown(text: string): string {
  if (!text) return ''

  return text
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
}
