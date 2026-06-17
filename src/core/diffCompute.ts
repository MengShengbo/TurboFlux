// ============================================================================
// Diff computation primitives for AI edit visualization.
// ----------------------------------------------------------------------------
// Pure functions, no IPC, no store access. Built on top of jsdiff (Myers diff)
// so we don't reinvent a hardened algorithm. Used by:
//   - ChatView edit tool card: render unified hunks lazily on expand.
//   - CodeEditor (Monaco): convert hunks to line-level decoration spans.
//   - editorStore: centralized cache of AI-touched paths and their hunks.
//
// Size discipline (DeepSeek-style "FP8 mixed precision" — keep the cheap path
// always available, only commit memory when the input is small enough):
//   - canComputeDiff() gates input size at 256 KB per side. Bigger files fall
//     back to existing oldPreview/preview heuristics elsewhere; they never
//     get a full diff card.
//   - hunks are computed lazily by callers (useMemo / store getter), not by
//     the engine eagerly. Folded UI = zero diff work.
// ============================================================================

import { structuredPatch } from 'diff'

/** Maximum input size per side (bytes / characters). 256 KB is enough for
 *  almost any source file we'd realistically diff inline; above this the
 *  Myers diff cost and the memory copy cost outweigh the UX benefit. */
export const MAX_DIFF_INPUT_BYTES = 256 * 1024
export const DEFAULT_UNIFIED_DIFF_CONTEXT_LINES = 3

export type DiffLineKind = 'context' | 'add' | 'remove'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line number in the original (preimage) file. Set for context+remove. */
  oldLine?: number
  /** 1-based line number in the new (postimage) file. Set for context+add. */
  newLine?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffStats {
  added: number
  removed: number
  hunkCount: number
}

/** Span of lines in the *current* (new) file that should be visually marked. */
export interface HunkLineSpan {
  /** 1-based start line in the new file. */
  startLine: number
  /** 1-based inclusive end line in the new file. */
  endLine: number
  kind: 'add' | 'remove' | 'change'
}

/**
 * Returns true if both inputs are small enough that we should compute a full
 * diff. Above the cap, callers should fall back to lightweight stats only.
 */
export function canComputeDiff(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  if (typeof before !== 'string' || typeof after !== 'string') return false
  if (before.length > MAX_DIFF_INPUT_BYTES) return false
  if (after.length > MAX_DIFF_INPUT_BYTES) return false
  return true
}

/**
 * Compute structured hunks between two strings using jsdiff's Myers
 * implementation. Returns [] when inputs are identical.
 *
 * `context` is the number of context lines surrounding each change (default 3,
 * matches `git diff` and is enough to read each hunk in isolation).
 */
export function computeHunks(before: string, after: string, context = DEFAULT_UNIFIED_DIFF_CONTEXT_LINES): DiffHunk[] {
  if (before === after) return []
  const patch = structuredPatch('a', 'b', before, after, '', '', { context })
  return patch.hunks.map(toHunk)
}

function toHunk(h: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }): DiffHunk {
  let oldCursor = h.oldStart
  let newCursor = h.newStart
  const lines: DiffLine[] = []
  for (const raw of h.lines) {
    const tag = raw[0]
    const text = raw.slice(1)
    if (tag === '+') {
      lines.push({ kind: 'add', text, newLine: newCursor })
      newCursor += 1
    } else if (tag === '-') {
      lines.push({ kind: 'remove', text, oldLine: oldCursor })
      oldCursor += 1
    } else if (tag === '\\') {
      // "\ No newline at end of file" marker — skip; not user-visible.
      continue
    } else {
      // Context line (' ') or any other unexpected leading char treated as context.
      lines.push({ kind: 'context', text, oldLine: oldCursor, newLine: newCursor })
      oldCursor += 1
      newCursor += 1
    }
  }
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines,
  }
}

/**
 * Aggregate added/removed line counts and hunk count from a hunk list.
 *
 * NOTE: This is the authoritative source for the +X/-Y badge in the UI.
 * The previous heuristic in agentEngine (oldLines vs newLines of the
 * old_string/new_string chunks) was misleading for partial-block edits;
 * this counts the actual diff output.
 */
export function summarizeHunks(hunks: DiffHunk[]): DiffStats {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'remove') removed += 1
    }
  }
  return { added, removed, hunkCount: hunks.length }
}

/**
 * Convert hunks into spans of consecutive line numbers in the *new* file,
 * suitable for Monaco line-level decorations. Pure deletions (no following
 * add/context) anchor a single 'remove' marker at the hunk's newStart.
 *
 * Each span is one of:
 *   - 'add': run of newly added lines (no surrounding remove in the same run)
 *   - 'change': run of added lines that replaced removed lines
 *   - 'remove': pure-deletion anchor (single line marker)
 */
export function hunksToCurrentSpans(hunks: DiffHunk[]): HunkLineSpan[] {
  const spans: HunkLineSpan[] = []
  for (const h of hunks) {
    let runStart: number | null = null
    let runEnd: number | null = null
    let runHasRemove = false
    let hunkHadAnyAdd = false
    let hunkHadAnyRemove = false

    const flushRun = () => {
      if (runStart != null && runEnd != null) {
        spans.push({
          startLine: runStart,
          endLine: runEnd,
          kind: runHasRemove ? 'change' : 'add',
        })
      }
      runStart = null
      runEnd = null
      runHasRemove = false
    }

    for (const line of h.lines) {
      if (line.kind === 'add' && line.newLine != null) {
        if (runStart == null) runStart = line.newLine
        runEnd = line.newLine
        hunkHadAnyAdd = true
      } else if (line.kind === 'remove') {
        runHasRemove = true
        hunkHadAnyRemove = true
      } else {
        // context line — close any open run
        flushRun()
      }
    }
    flushRun()

    // Pure-deletion hunk: no adds at all but did remove lines. Anchor a
    // single-line marker at the new-file location where the removal happened.
    if (!hunkHadAnyAdd && hunkHadAnyRemove) {
      const anchor = Math.max(1, h.newStart)
      spans.push({ startLine: anchor, endLine: anchor, kind: 'remove' })
    }
  }
  return spans
}

/** Heuristic operation classifier from a stats triple. */
export function classifyOperation(stats: DiffStats): 'add' | 'remove' | 'change' | 'noop' {
  if (stats.added === 0 && stats.removed === 0) return 'noop'
  if (stats.added > 0 && stats.removed === 0) return 'add'
  if (stats.removed > 0 && stats.added === 0) return 'remove'
  return 'change'
}
