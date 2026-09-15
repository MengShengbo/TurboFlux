/**
 * Normalize an OpenAI-compatible base URL.
 *
 * Many users paste URLs like `https://api.example.com` or
 * `https://api.example.com/` without the `/v1` suffix. This function
 * ensures the URL ends with `/v1` so callers can simply append
 * `/models`, `/chat/completions`, etc.
 *
 * Rules:
 * - Strips trailing slash
 * - If the path already contains a version segment (e.g. `/v1`, `/v2`),
 *   leaves it as-is
 * - Otherwise appends `/v1`
 *
 * Examples:
 *   https://api.example.com       → https://api.example.com/v1
 *   https://api.example.com/      → https://api.example.com/v1
 *   https://api.example.com/v1    → https://api.example.com/v1
 *   https://api.example.com/v1/   → https://api.example.com/v1
 *   https://api.openai.com/v1     → https://api.openai.com/v1
 *   https://proxy.com/api/v1      → https://proxy.com/api/v1
 *   https://proxy.com/custom-path → https://proxy.com/custom-path/v1
 */
export function normalizeBaseUrl(url: string): string {
  // Strip trailing slashes
  const cleaned = url.replace(/\/+$/, '')

  // If it already ends with a version path like /v1, /v2, etc. — leave it
  if (/\/v\d+$/.test(cleaned)) return cleaned

  // If the URL contains /v1/ somewhere in the middle (e.g. https://x.com/v1/extra) — leave it
  // This handles cases where someone already has a versioned path
  if (/\/v\d+\//.test(cleaned)) return cleaned

  // Otherwise, append /v1
  return `${cleaned}/v1`
}
