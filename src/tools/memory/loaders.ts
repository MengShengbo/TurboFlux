/**
 * Workspace memory loaders.
 *
 * Each loader reads one common rule or memory file shape, parses it into
 * Memory entries, and returns a MemoryGroup. Supported inputs:
 *
 * - <wsRoot>/.turboflux/memory/rules.md
 * - <wsRoot>/.turboflux/memory/facts.jsonl
 * - <wsRoot>/.cursorrules
 * - <wsRoot>/.cursor/rules/*.md(c)
 * - <wsRoot>/CLAUDE.md, claude.md
 * - <wsRoot>/.claude/CLAUDE.md
 * - <wsRoot>/AGENTS.md, agents.md
 * - <wsRoot>/.windsurfrules
 * - <wsRoot>/.windsurf/rules/*.md
 * - <wsRoot>/.clinerules
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Memory, MemoryGroup } from '../../shared/memoryTypes'
import { sanitizeMemoryText } from './sanitizer'

interface LoaderContext {
  workspacePath: string
  warnings: string[]
}

interface ParseResult {
  text: string
  tags: string[]
}

const MEMORIES_PER_GROUP_MAX = 32
const FILE_BYTES_MAX = 64 * 1024
const FACTS_JSONL_BYTES_MAX = 4 * 1024 * 1024

function memoryId(absPath: string, index: number): string {
  let hash = 5381
  for (let i = 0; i < absPath.length; i += 1) {
    hash = ((hash << 5) + hash + absPath.charCodeAt(i)) | 0
  }
  return `mem_${(hash >>> 0).toString(36)}_${index}`
}

function toRelative(workspacePath: string, absPath: string): string {
  const rel = path.relative(workspacePath, absPath).replace(/\\/g, '/')
  return rel.startsWith('..') ? absPath.replace(/\\/g, '/') : rel
}

function readTextFileSafe(absPath: string, ctx: LoaderContext, maxBytes = FILE_BYTES_MAX): string | null {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) return null
    if (stat.size > maxBytes) {
      ctx.warnings.push(`Skipped ${toRelative(ctx.workspacePath, absPath)}: file exceeds ${maxBytes} bytes`)
      return null
    }
    return fs.readFileSync(absPath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT' && code !== 'ENOTDIR') {
      ctx.warnings.push(`Failed to read ${toRelative(ctx.workspacePath, absPath)}: ${code}`)
    }
    return null
  }
}

function stripFrontmatter(content: string): ParseResult {
  if (!content.startsWith('---')) return { text: content, tags: [] }

  const endIdx = content.indexOf('\n---', 3)
  if (endIdx < 0) return { text: content, tags: [] }

  const body = content.slice(endIdx + 4).replace(/^\n+/, '')
  const head = content.slice(3, endIdx)
  const tags: string[] = []

  for (const line of head.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].replace(/^["'`]|["'`]$/g, '')
    if (value && value !== 'true' && value !== 'false') {
      tags.push(`${key}:${value}`.slice(0, 64))
    } else if (value === 'true') {
      tags.push(key)
    }
  }

  return { text: body, tags }
}

function splitMarkdownIntoBullets(body: string): string[] {
  const trimmed = body.trim()
  if (!trimmed) return []

  const lines = trimmed.split(/\r?\n/)
  const bullets: string[] = []
  let current: string[] = []
  const bulletStart = /^\s*(?:[-*+]|\d+[.)])\s+/

  const flush = (): void => {
    if (current.length === 0) return
    const joined = current.join(' ').replace(/\s+/g, ' ').trim()
    if (joined) bullets.push(joined)
    current = []
  }

  for (const line of lines) {
    if (bulletStart.test(line)) {
      flush()
      current.push(line.replace(bulletStart, ''))
    } else if (/^\s*#{1,6}\s+/.test(line)) {
      flush()
    } else if (/^\s*$/.test(line)) {
      flush()
    } else if (current.length > 0) {
      current.push(line.trim())
    } else {
      current.push(line.trim())
    }
  }
  flush()

  return bullets.length === 0 ? [trimmed.replace(/\s+/g, ' ').trim()] : bullets
}

function buildMemoriesFromBody(
  absPath: string,
  body: string,
  extraTags: string[],
  ctx: LoaderContext,
): Memory[] {
  const bullets = splitMarkdownIntoBullets(body)
  const relSource = toRelative(ctx.workspacePath, absPath)
  let mtime = Date.now()
  try {
    mtime = fs.statSync(absPath).mtimeMs
  } catch {
    // Use current time when stat fails.
  }

  const out: Memory[] = []
  for (let i = 0; i < bullets.length && out.length < MEMORIES_PER_GROUP_MAX; i += 1) {
    const sanitized = sanitizeMemoryText(bullets[i])
    if (!sanitized) continue
    out.push({
      id: memoryId(absPath, i),
      scope: 'workspace_shared',
      kind: 'rule',
      text: sanitized,
      source: relSource,
      evidence: [{ kind: 'file', path: relSource }],
      confidence: 'asserted',
      createdAt: mtime,
      updatedAt: mtime,
      pinned: false,
      tags: extraTags,
      reviewState: 'user_edited',
      status: 'active',
    })
  }

  if (bullets.length > MEMORIES_PER_GROUP_MAX) {
    ctx.warnings.push(
      `Capped ${relSource}: ${bullets.length - MEMORIES_PER_GROUP_MAX} additional rules ignored`,
    )
  }

  return out
}

function loadMarkdownRuleFile(
  absPath: string,
  groupLabel: string,
  loaderName: string,
  extraTags: string[],
  ctx: LoaderContext,
): MemoryGroup | null {
  const raw = readTextFileSafe(absPath, ctx)
  if (raw == null) return null

  const { text, tags } = stripFrontmatter(raw)
  const items = buildMemoriesFromBody(absPath, text, [...extraTags, ...tags], ctx)
  if (items.length === 0) return null

  return {
    id: `grp_${memoryId(absPath, 0)}`,
    label: groupLabel,
    source: toRelative(ctx.workspacePath, absPath),
    loader: loaderName,
    items,
  }
}

function loadRuleDirectory(
  absDirPath: string,
  groupLabel: string,
  loaderName: string,
  fileExtensions: string[],
  ctx: LoaderContext,
): MemoryGroup[] {
  let entries: fs.Dirent[]
  try {
    const stat = fs.statSync(absDirPath)
    if (!stat.isDirectory()) return []
    entries = fs.readdirSync(absDirPath, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT' && code !== 'ENOTDIR') {
      ctx.warnings.push(`Failed to scan ${toRelative(ctx.workspacePath, absDirPath)}: ${code}`)
    }
    return []
  }

  const groups: MemoryGroup[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue
    if (!fileExtensions.some(ext => entry.name.toLowerCase().endsWith(ext))) continue

    const group = loadMarkdownRuleFile(
      path.join(absDirPath, entry.name),
      `${groupLabel} - ${entry.name}`,
      loaderName,
      [],
      ctx,
    )
    if (group) groups.push(group)
  }
  return groups
}

function loadTurbofluxFactsJsonl(absPath: string, ctx: LoaderContext): MemoryGroup | null {
  const raw = readTextFileSafe(absPath, ctx, FACTS_JSONL_BYTES_MAX)
  if (raw == null) return null

  const relSource = toRelative(ctx.workspacePath, absPath)
  let mtime = Date.now()
  try {
    mtime = fs.statSync(absPath).mtimeMs
  } catch {
    // Use current time when stat fails.
  }

  const byId = new Map<string, Memory>()
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//') || line.startsWith('#')) continue

    let parsed: Partial<Memory> | null = null
    try {
      parsed = JSON.parse(line) as Partial<Memory>
    } catch {
      continue
    }

    if (!parsed || typeof parsed.text !== 'string') continue
    const sanitized = sanitizeMemoryText(parsed.text)
    if (!sanitized) continue

    const id = parsed.id || memoryId(absPath, i)
    byId.set(id, {
      id,
      scope: (parsed.scope as Memory['scope']) || 'workspace_shared',
      kind: (parsed.kind as Memory['kind']) || 'fact',
      text: sanitized,
      source: typeof parsed.source === 'string' ? parsed.source : relSource,
      evidence: Array.isArray(parsed.evidence) && parsed.evidence.length > 0
        ? parsed.evidence
        : [{ kind: 'file', path: relSource }],
      confidence: (parsed.confidence as Memory['confidence']) || 'observed',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : mtime,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : mtime,
      pinned: parsed.pinned === true,
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 12) : [],
      reviewState: (parsed.reviewState as Memory['reviewState']) || 'auto',
      status: (parsed.status as Memory['status']) || 'active',
      supersededBy: typeof parsed.supersededBy === 'string' ? parsed.supersededBy : undefined,
    })
  }

  const items = Array.from(byId.values())
    .filter(m => m.status === 'active')
    .slice(0, MEMORIES_PER_GROUP_MAX)

  if (items.length === 0) return null
  return {
    id: `grp_${memoryId(absPath, 0)}`,
    label: 'Project Facts',
    source: relSource,
    loader: 'turboflux_facts_jsonl',
    items,
  }
}

export function loadAllMemoryGroups(workspacePath: string): {
  groups: MemoryGroup[]
  warnings: string[]
  loadersAttempted: string[]
} {
  const ctx: LoaderContext = { workspacePath, warnings: [] }
  const groups: MemoryGroup[] = []
  const loadersAttempted: string[] = []

  loadersAttempted.push('turboflux_md')
  for (const candidate of ['TURBOFLUX.md', 'turboflux.md', '.turboflux/TURBOFLUX.md']) {
    const group = loadMarkdownRuleFile(
      path.join(workspacePath, candidate),
      'Project Instructions',
      'turboflux_md',
      ['turboflux', 'project'],
      ctx,
    )
    if (group) {
      groups.push(group)
      break
    }
  }

  loadersAttempted.push('turboflux_rules_md')
  const turbofluxRules = loadMarkdownRuleFile(
    path.join(workspacePath, '.turboflux', 'memory', 'rules.md'),
    'Project Rules',
    'turboflux_rules_md',
    ['turboflux'],
    ctx,
  )
  if (turbofluxRules) groups.push(turbofluxRules)

  loadersAttempted.push('turboflux_facts_jsonl')
  const turbofluxFacts = loadTurbofluxFactsJsonl(
    path.join(workspacePath, '.turboflux', 'memory', 'facts.jsonl'),
    ctx,
  )
  if (turbofluxFacts) groups.push(turbofluxFacts)

  loadersAttempted.push('claude_md')
  for (const candidate of ['CLAUDE.md', 'claude.md', '.claude/CLAUDE.md', '.claude/claude.md']) {
    const group = loadMarkdownRuleFile(
      path.join(workspacePath, candidate),
      `Claude Rules - ${candidate}`,
      'claude_md',
      ['claude'],
      ctx,
    )
    if (group) {
      groups.push(group)
      break
    }
  }

  loadersAttempted.push('agents_md')
  for (const candidate of ['AGENTS.md', 'agents.md']) {
    const group = loadMarkdownRuleFile(
      path.join(workspacePath, candidate),
      `Agents Rules - ${candidate}`,
      'agents_md',
      ['agents'],
      ctx,
    )
    if (group) {
      groups.push(group)
      break
    }
  }

  loadersAttempted.push('cursorrules')
  const cursorLegacy = loadMarkdownRuleFile(
    path.join(workspacePath, '.cursorrules'),
    'Cursor Rules',
    'cursorrules',
    ['cursor'],
    ctx,
  )
  if (cursorLegacy) groups.push(cursorLegacy)

  loadersAttempted.push('cursor_rules_dir')
  groups.push(
    ...loadRuleDirectory(
      path.join(workspacePath, '.cursor', 'rules'),
      'Cursor Rules',
      'cursor_rules_dir',
      ['.md', '.mdc'],
      ctx,
    ),
  )

  loadersAttempted.push('windsurfrules')
  const windsurfLegacy = loadMarkdownRuleFile(
    path.join(workspacePath, '.windsurfrules'),
    'Windsurf Rules',
    'windsurfrules',
    ['windsurf'],
    ctx,
  )
  if (windsurfLegacy) groups.push(windsurfLegacy)

  loadersAttempted.push('windsurf_rules_dir')
  groups.push(
    ...loadRuleDirectory(
      path.join(workspacePath, '.windsurf', 'rules'),
      'Windsurf Rules',
      'windsurf_rules_dir',
      ['.md'],
      ctx,
    ),
  )

  loadersAttempted.push('clinerules')
  const cline = loadMarkdownRuleFile(
    path.join(workspacePath, '.clinerules'),
    'Cline Rules',
    'clinerules',
    ['cline'],
    ctx,
  )
  if (cline) groups.push(cline)

  return { groups, warnings: ctx.warnings, loadersAttempted }
}
