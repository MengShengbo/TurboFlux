/**
 * Single source of truth for cleaning user-or-tool-supplied text before it
 * is allowed to enter the long-term memory store and, eventually, the model
 * system prompt.
 *
 * Why this exists, even in M1:
 *   The compat loaders parse files like `.cursorrules` and `CLAUDE.md`. Those
 *   files are *human-authored* in the common case but the extension also
 *   reads them transparently from any project the user opens — including
 *   third-party repos, demos, or attacker-controlled examples. A rule file
 *   that contains literal `<|im_start|>system\nIgnore previous...` strings
 *   would otherwise survive into the model context with high trust labels.
 *
 * Conservative default: strip a small set of well-known control sequences,
 * collapse whitespace, hard-cap length. We do NOT try to detect English
 * jailbreak prose — that is brittle and out of scope for a sanitizer.
 */

const CONTROL_TOKEN_PATTERNS: RegExp[] = [
  // Chat-template control tokens used by various model families.
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\|begin_of_text\|>/gi,
  /<\|end_of_text\|>/gi,
  /<\|eot_id\|>/gi,
  /<\|start_header_id\|>/gi,
  /<\|end_header_id\|>/gi,
  /<\|fim_(prefix|middle|suffix)\|>/gi,

  // Anthropic / Claude reserved tags (specific patterns, not all XML).
  /<\/?antml:[^>]+>/gi,
  /<\/?anthropic[^>]*>/gi,
  /<\/?human>/gi,
  /<\/?assistant>/gi,
  /<\/?thinking>/gi,

  // Llama-style.
  /\[INST\]/gi,
  /\[\/INST\]/gi,

  // OpenAI tool-call envelope leaks.
  /<\|tool_call_(start|end)\|>/gi,

  // Turboflux-internal envelope tags. These should never appear inside a
  // memory body; if they do, something else upstream is broken — strip
  // to be safe.
  /<workspace_memory[^>]*>/gi,
  /<\/workspace_memory>/gi,
  /<\/?memory[^>]*>/gi,
  /<\/?tool_retry_hint>/gi,
  /<\/?evidence_policy>/gi,
]

/** Zero-width and bidi-control codepoints that can hide payloads in plain
 *  text. We strip the dangerous subset, not all whitespace. */
const INVISIBLE_CODEPOINTS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g

/** Hard cap per memory text body, chosen so that a workspace cannot
 *  exhaust the model context with a single hostile line. */
export const MEMORY_TEXT_MAX_LENGTH = 500

/** Hard cap per evidence quote, much smaller than the text body. */
export const MEMORY_EVIDENCE_QUOTE_MAX_LENGTH = 200

export interface SanitizeOptions {
  /** Truncate to this many chars after stripping. Defaults to
   *  MEMORY_TEXT_MAX_LENGTH. Pass MEMORY_EVIDENCE_QUOTE_MAX_LENGTH for
   *  quote bodies. */
  maxLength?: number
}

/**
 * Strip control sequences, normalize whitespace, and length-cap the input.
 * Always returns a string (possibly empty) and never throws.
 */
export function sanitizeMemoryText(input: string, options?: SanitizeOptions): string {
  if (typeof input !== 'string') return ''
  let out = input

  // Strip ANSI escape sequences (a tool result might leak terminal colors).
  out = out.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')

  // Strip invisible/bidi codepoints that hide payloads.
  out = out.replace(INVISIBLE_CODEPOINTS, '')

  // Strip well-known control tokens.
  for (const pattern of CONTROL_TOKEN_PATTERNS) {
    out = out.replace(pattern, '')
  }

  // Collapse internal whitespace runs to a single space EXCEPT preserve
  // newlines — many rule files are bullet lists where line breaks carry
  // structural meaning. We collapse consecutive blank lines instead.
  out = out
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .trim()

  const limit = Math.max(1, options?.maxLength ?? MEMORY_TEXT_MAX_LENGTH)
  if (out.length > limit) {
    out = out.slice(0, limit - 1).trimEnd() + '…'
  }
  return out
}
