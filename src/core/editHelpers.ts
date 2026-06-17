// ============================================================================
// Edit helpers for edit_file and multi_edit tool dispatch.
// ----------------------------------------------------------------------------
// read_file emits cat -n style line-number prefixes ("    42\u2192content").
// The model is told to strip those prefixes when copying text into edit args.
// We defensively strip them again here so a stray prefix never breaks an
// otherwise-valid edit.
// ============================================================================

const LINE_NUMBER_ARROW = '\u2192'
const LINE_NUMBER_PREFIX_RE = new RegExp(`^[ \\t]*\\d+${LINE_NUMBER_ARROW}`)

/**
 * Defensively strip cat -n style line-number prefixes from a string.
 *
 * Behavior:
 *  - If the input does not contain the line-number arrow, return unchanged.
 *  - If any non-empty line lacks the prefix, return unchanged. This keeps
 *    legitimate arrows in source code from being garbled.
 *  - Otherwise, strip the prefix from every line.
 *  - undefined / non-string inputs return ''.
 */
export function stripLineNumberPrefix(value: string | undefined): string {
  if (typeof value !== 'string' || !value) return value ?? ''
  if (!value.includes(LINE_NUMBER_ARROW)) return value
  const lines = value.split('\n')
  const nonEmpty = lines.filter(l => l.trim().length > 0)
  if (nonEmpty.length === 0) return value
  if (!nonEmpty.every(l => LINE_NUMBER_PREFIX_RE.test(l))) return value
  return lines.map(l => l.replace(LINE_NUMBER_PREFIX_RE, '')).join('\n')
}

export type EditStepResult =
  | { content: string; replacements: number }
  | { error: string }

/**
 * Apply a single targeted edit to a source string.
 *
 *  - oldContent must be non-empty and must differ from newContent.
 *  - When replaceAll is false, oldContent must occur exactly once.
 *  - When replaceAll is true, every occurrence is replaced and counted.
 */
export function applyEdit(
  source: string,
  oldContent: string,
  newContent: string,
  replaceAll: boolean,
  pathLabel: string,
): EditStepResult {
  if (typeof oldContent !== 'string' || oldContent.length === 0) {
    return { error: `old_string cannot be empty (${pathLabel})` }
  }
  if (oldContent === newContent) {
    return { error: `old_string and new_string are identical - no-op edit not allowed (${pathLabel})` }
  }
  const occurrenceCount = source.split(oldContent).length - 1
  if (occurrenceCount === 0) {
    return { error: `old_string not found in ${pathLabel}. Match must be exact (indentation + whitespace).` }
  }
  if (occurrenceCount > 1 && !replaceAll) {
    return { error: `found ${occurrenceCount} occurrences of old_string in ${pathLabel}. Either add more surrounding context to make the match unique, or pass replace_all=true.` }
  }
  if (replaceAll) {
    return { content: source.split(oldContent).join(newContent), replacements: occurrenceCount }
  }
  return { content: source.replace(oldContent, newContent), replacements: 1 }
}
