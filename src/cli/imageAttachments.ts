import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { AgentAttachment } from '../shared/agentTypes'

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export interface ResolvedImagePrompt {
  prompt: string
  attachments: AgentAttachment[]
  warnings: string[]
}

export interface ResolveImagePromptOptions {
  existingAttachments?: AgentAttachment[]
}

interface ImageRef {
  raw: string
  path: string
}

export function hasImageReference(input: string): boolean {
  return collectImageRefs(input).length > 0
}

export function resolveImagePrompt(input: string, workspacePath: string, options: ResolveImagePromptOptions = {}): ResolvedImagePrompt {
  const refs = collectImageRefs(input)
  const placeholders = collectImagePlaceholders(input)
  const warnings: string[] = []
  let prompt = input
  const existing = normalizeExistingAttachments(prompt, options.existingAttachments ?? [])
  prompt = existing.prompt
  const attachments: AgentAttachment[] = existing.attachments
  const replacements = new Map<string, string>()

  for (const ref of refs) {
    const resolved = resolveInputPath(ref.path, workspacePath)
    const attachment = attachImageFile(resolved, attachments.length + 1, warnings)
    if (!attachment) continue
    attachments.push(attachment)
    replacements.set(ref.raw, imagePlaceholderForIndex(attachments.length))
  }

  if (placeholders.length > 0 && attachments.length === 0) {
    const attachment = captureClipboardImageAttachment(1, warnings, workspacePath)
    if (attachment) attachments.push(attachment)
    if (attachment && placeholders.length > 1) {
      warnings.push('Only one image can be read from the clipboard at submit time. Paste image files or use Ctrl+V for each image while composing.')
    }
  }

  for (const [raw, token] of replacements) {
    prompt = prompt.split(raw).join(token)
  }
  prompt = normalizeImagePlaceholders(prompt)
  const missingPlaceholders = maxImagePlaceholderIndex(prompt) - attachments.length
  if (missingPlaceholders > 0) {
    warnings.push(`${missingPlaceholders} image placeholder(s) do not have an attached image.`)
  }

  return { prompt, attachments, warnings }
}

export function isSupportedImagePath(value: string): boolean {
  return Boolean(mimeForPath(value))
}

export function imagePlaceholderForIndex(index: number): string {
  return `[Image #${index}]`
}

function collectImageRefs(input: string): ImageRef[] {
  const refs: ImageRef[] = []
  const seen = new Set<string>()
  const add = (raw: string, value: string) => {
    const cleaned = normalizePastedPath(value)
    if (!cleaned || !isSupportedImagePath(cleaned)) return
    if (seen.has(cleaned)) return
    seen.add(cleaned)
    refs.push({ raw, path: cleaned })
  }

  for (const match of input.matchAll(/<image\b[^>]*\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>[\s\S]*?<\/image>/gi)) {
    add(match[0], decodeImagePathAttr(match[1] || match[2] || match[3] || ''))
  }
  for (const match of input.matchAll(/<image\b[^>]*\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*\/?>/gi)) {
    add(match[0], decodeImagePathAttr(match[1] || match[2] || match[3] || ''))
  }
  for (const match of input.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    add(match[0], match[1])
  }
  for (const match of input.matchAll(/<image:([^>]+)>/gi)) {
    add(match[0], match[1])
  }
  for (const match of input.matchAll(/"([^"]+\.(?:png|jpe?g|webp|gif|bmp))"|'([^']+\.(?:png|jpe?g|webp|gif|bmp))'/gi)) {
    add(match[0], match[1] || match[2])
  }
  for (const match of input.matchAll(/file:\/\/[^<>"'\s]+\.(?:png|jpe?g|webp|gif|bmp)/gi)) {
    add(match[0], match[0])
  }
  for (const match of input.matchAll(/(?:[A-Za-z]:\\|\\\\|\/|\.{1,2}[\\/])[^<>"'\r\n]+?\.(?:png|jpe?g|webp|gif|bmp)/gi)) {
    add(match[0], match[0])
  }

  return refs
}

function collectImagePlaceholders(input: string): string[] {
  return Array.from(input.matchAll(/(?:<image\d*>|\[Image\s*#?\s*\d+])/gi)).map(match => match[0])
}

function decodeImagePathAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function normalizeExistingAttachments(input: string, attachments: AgentAttachment[]): { prompt: string; attachments: AgentAttachment[] } {
  let prompt = input
  const kept: AgentAttachment[] = []
  for (let originalIndex = 0; originalIndex < attachments.length; originalIndex += 1) {
    const oldIndex = originalIndex + 1
    if (!hasPlaceholderForIndex(prompt, oldIndex)) continue
    const nextIndex = kept.length + 1
    prompt = replacePlaceholderIndex(prompt, oldIndex, nextIndex)
    kept.push({ ...attachments[originalIndex], id: `image${nextIndex}` })
  }
  return { prompt, attachments: kept }
}

function hasPlaceholderForIndex(input: string, index: number): boolean {
  return new RegExp(`(?:<image${index}>|\\[Image\\s*#?\\s*${index}])`, 'i').test(input)
}

function replacePlaceholderIndex(input: string, fromIndex: number, toIndex: number): string {
  const replacement = imagePlaceholderForIndex(toIndex)
  return input
    .replace(new RegExp(`<image${fromIndex}>`, 'gi'), replacement)
    .replace(new RegExp(`\\[Image\\s*#?\\s*${fromIndex}]`, 'gi'), replacement)
}

function normalizeImagePlaceholders(input: string): string {
  return input
    .replace(/<image(\d*)>/gi, (_, index) => imagePlaceholderForIndex(Number(index || '1')))
    .replace(/\[Image\s*#?\s*(\d+)]/gi, (_, index) => imagePlaceholderForIndex(Number(index)))
}

function maxImagePlaceholderIndex(input: string): number {
  let max = 0
  for (const match of input.matchAll(/\[Image\s*#\s*(\d+)]/gi)) {
    max = Math.max(max, Number(match[1]))
  }
  return max
}

function attachImageFile(filePath: string, index: number, warnings: string[]): AgentAttachment | null {
  const mime = mimeForPath(filePath)
  if (!mime) return null
  if (!existsSync(filePath)) {
    warnings.push(`Image not found: ${filePath}`)
    return null
  }
  const stat = statSync(filePath)
  if (!stat.isFile()) {
    warnings.push(`Image path is not a file: ${filePath}`)
    return null
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    warnings.push(`Image is larger than ${formatBytes(MAX_IMAGE_BYTES)} and was not attached: ${filePath}`)
    return null
  }

  const targetDir = attachmentDir()
  mkdirSync(targetDir, { recursive: true })
  const ext = extname(filePath).toLowerCase() || '.png'
  const target = join(targetDir, `image-${Date.now()}-${index}${ext}`)
  copyFileSync(filePath, target)
  const targetStat = statSync(target)
  return {
    id: `image${index}`,
    type: 'image',
    path: target,
    mime,
    filename: basename(filePath),
    size: targetStat.size,
  }
}

export function captureClipboardImageAttachment(index: number, warnings: string[] = [], workspacePath = process.cwd()): AgentAttachment | null {
  if (process.platform !== 'win32') {
    warnings.push('Clipboard image paste is currently only available on Windows.')
    return null
  }

  const fileAttachment = captureClipboardImageFileAttachment(index, warnings, workspacePath)
  if (fileAttachment) return fileAttachment

  const bitmapAttachment = captureClipboardBitmapAttachment(index, warnings)
  if (bitmapAttachment) return bitmapAttachment

  warnings.push('No image was found in the Windows clipboard. Paste an image path or copy an image first.')
  return null
}

function captureClipboardBitmapAttachment(index: number, warnings: string[]): AgentAttachment | null {
  const targetDir = attachmentDir()
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, `clipboard-${Date.now()}-${index}.png`)
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $img) { $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue }",
    "if ($null -eq $img) { exit 2 }",
    `$img.Save(${JSON.stringify(target)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$img.Dispose()",
  ].join('; ')

  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf-8',
    windowsHide: true,
  })
  if (result.status !== 0 || !existsSync(target)) {
    return null
  }
  const stat = statSync(target)
  if (stat.size > MAX_IMAGE_BYTES) {
    warnings.push(`Clipboard image is larger than ${formatBytes(MAX_IMAGE_BYTES)} and was not attached.`)
    return null
  }
  return {
    id: `image${index}`,
    type: 'image',
    path: target,
    mime: 'image/png',
    filename: basename(target),
    size: stat.size,
  }
}

function captureClipboardImageFileAttachment(index: number, warnings: string[], workspacePath: string): AgentAttachment | null {
  const refs = readClipboardImageRefs()
  for (const ref of refs) {
    const attachment = attachImageFile(resolveInputPath(ref, workspacePath), index, warnings)
    if (attachment) return attachment
  }
  return null
}

function readClipboardImageRefs(): string[] {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$files = @()",
    "if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {",
    "  $list = [System.Windows.Forms.Clipboard]::GetFileDropList()",
    "  foreach ($item in $list) { $files += [string]$item }",
    "}",
    "$text = ''",
    "if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() }",
    "$payload = [pscustomobject]@{ files = $files; text = $text }",
    "$payload | ConvertTo-Json -Compress",
  ].join('; ')

  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf-8',
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout.trim()) return []

  try {
    const parsed = JSON.parse(result.stdout.trim()) as { files?: unknown; text?: unknown }
    const refs: string[] = []
    const files = Array.isArray(parsed.files) ? parsed.files : typeof parsed.files === 'string' ? [parsed.files] : []
    for (const file of files) {
      if (typeof file === 'string' && isSupportedImagePath(file)) refs.push(file)
    }
    if (typeof parsed.text === 'string' && parsed.text.trim()) {
      refs.push(...collectImageRefs(parsed.text).map(ref => ref.path))
    }
    return Array.from(new Set(refs))
  } catch {
    return []
  }
}

function attachmentDir(): string {
  return join(tmpdir(), 'turboflux-attachments')
}

function resolveInputPath(value: string, workspacePath: string): string {
  const normalized = normalizePastedPath(value)
  if (/^file:\/\//i.test(normalized)) {
    return decodeURIComponent(new URL(normalized).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  }
  if (normalized.startsWith('~/')) {
    return resolve(process.env.USERPROFILE || process.env.HOME || workspacePath, normalized.slice(2))
  }
  return isAbsolute(normalized) ? normalized : resolve(workspacePath, normalized)
}

function normalizePastedPath(value: string): string {
  return value.trim()
    .replace(/^<|>$/g, '')
    .replace(/^file:\/\//i, match => match.toLowerCase())
}

function mimeForPath(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()] || null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

export function imageAttachmentToDataUrl(attachment: AgentAttachment): string | null {
  if (!attachment.mime.startsWith('image/')) return null
  if (!existsSync(attachment.path)) return null
  const bytes = readFileSync(attachment.path)
  if (bytes.length > MAX_IMAGE_BYTES) return null
  return `data:${attachment.mime};base64,${bytes.toString('base64')}`
}
