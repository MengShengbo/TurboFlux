/**
 * Token 级 tool_result 压缩 —— 不需要任何模型。
 *
 * 目标：在 tool_result 送进 ContextManager 之前，对"已经看过一次，
 * 不会被模型再直接引用"的大段文件内容/搜索结果做局部压缩，保留原义。
 *
 * 设计原则（借鉴 LLMLingua-2 的思路但不依赖 BERT 模型）：
 * - 按行分组，保留"高信号"行：带符号声明、有数字/字符串字面量、
 *   含正则模式的行。
 * - 删掉"低信号"行：空行、超过阈值的缩进下一行相同模式、
 *   long import 列表里中段。
 * - 对 read_file 类工具：头尾保留、中段按 span 折叠。
 * - 对 search_content 类工具：按文件聚合，最多保留每文件前 K 条。
 *
 * 安全：压缩结果附带 "<compressed ratio=...>" 包围标记，模型看到后
 * 知道这是摘要、需要时可通过下一轮 tool_call 重新获取原文。
 */

const MIN_TEXT_FOR_COMPRESSION = 800 // chars (was 1500 — lowered to catch medium-sized outputs)
const HIGH_SIGNAL_PATTERNS = [
  /\b(export|import|from|function|class|interface|type|const|let|var|enum|return|throw|async|await)\b/,
  /\{|\}|=>|\(|\)|\[|\]/,
  /['"`]/,
  /\bTODO\b|\bFIXME\b|\bXXX\b|\bNOTE\b/,
  /^\s*\+|^\s*-\s/,
  /^\s*\/\//,
]

interface CompressOptions {
  /** 目标压缩率上限（0-1），默认 0.4 = 保留 ~40% 行。 */
  targetRatio?: number
  /** 开头/结尾强制保留行数，默认 10。 */
  headTailKeep?: number
  /** 允许的最大字符长度，超出则进一步收缩。 */
  maxChars?: number
}

export interface CompressionReport {
  compressed: string
  originalLength: number
  compressedLength: number
  ratio: number
  method: 'skipped' | 'line_prune' | 'span_fold' | 'search_aggregate'
}

/**
 * 主入口：根据 toolName 选择合适策略。未知工具走行剪枝兜底。
 */
export function compressToolResult(
  toolName: string,
  output: string,
  options: CompressOptions = {},
): CompressionReport {
  if (!output) {
    return { compressed: output, originalLength: 0, compressedLength: 0, ratio: 1, method: 'skipped' }
  }
  if (output.length < MIN_TEXT_FOR_COMPRESSION) {
    return {
      compressed: output,
      originalLength: output.length,
      compressedLength: output.length,
      ratio: 1,
      method: 'skipped',
    }
  }

  switch (toolName) {
    case 'read_file':
    case 'read_file_full':
    case 'read_file_range':
      return spanFoldCompress(output, options)
    case 'search_content':
    case 'search_files':
    case 'web_search':
    case 'grep':
      return searchAggregateCompress(output, options)
    default:
      return linePruneCompress(output, options)
  }
}

/** 按"首尾保留 + 中段按相似行折叠" 的策略压缩长文本（read_file 主场景）。 */
function spanFoldCompress(text: string, options: CompressOptions): CompressionReport {
  const lines = text.split(/\r?\n/)
  if (lines.length < 30) return linePruneCompress(text, options)

  const head = options.headTailKeep ?? 10
  const kept: string[] = []
  const keepSet = new Set<number>()
  for (let i = 0; i < Math.min(head, lines.length); i++) keepSet.add(i)
  for (let i = Math.max(0, lines.length - head); i < lines.length; i++) keepSet.add(i)

  // 中段：按高信号行的密度每 5-8 行 sample 一行
  for (let i = head; i < lines.length - head; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (HIGH_SIGNAL_PATTERNS.some(re => re.test(line))) {
      keepSet.add(i)
    }
  }

  let lastKept = -2
  let folded = 0
  for (let i = 0; i < lines.length; i++) {
    if (keepSet.has(i)) {
      if (folded > 0 && lastKept >= 0) {
        kept.push(`… <omitted ${folded} line${folded === 1 ? '' : 's'}> …`)
      }
      kept.push(lines[i])
      lastKept = i
      folded = 0
    } else {
      folded++
    }
  }
  if (folded > 0) kept.push(`… <omitted ${folded} trailing line${folded === 1 ? '' : 's'}> …`)

  let compressed = kept.join('\n')
  if (options.maxChars && compressed.length > options.maxChars) {
    compressed = compressed.slice(0, options.maxChars) + '\n… <truncated for token budget>'
  }
  return wrap(text, compressed, 'span_fold')
}

/** search_content 结果通常很冗长；按文件分组，每文件保留前 K 条 + 摘要。 */
function searchAggregateCompress(text: string, options: CompressOptions): CompressionReport {
  const lines = text.split(/\r?\n/)
  // 启发式：match lines 以 `path:line:` 开头，或 `L12 | content`
  const byFile = new Map<string, string[]>()
  const nonHits: string[] = []
  for (const line of lines) {
    const match = line.match(/^([\w./\\:-]+):(\d+):/) || line.match(/^([\w./\\-]+)\s*·\s*L(\d+)/)
    if (match) {
      const file = match[1]
      const list = byFile.get(file) || []
      list.push(line)
      byFile.set(file, list)
    } else {
      nonHits.push(line)
    }
  }
  if (byFile.size === 0) return linePruneCompress(text, options)

  const maxPerFile = 3
  const keptLines: string[] = []
  for (const [file, hits] of byFile) {
    const slice = hits.slice(0, maxPerFile)
    keptLines.push(...slice)
    if (hits.length > maxPerFile) {
      keptLines.push(`  … ${hits.length - maxPerFile} more match${hits.length - maxPerFile === 1 ? '' : 'es'} in ${file}`)
    }
  }
  const filesCount = byFile.size
  const hitsCount = Array.from(byFile.values()).reduce((sum, arr) => sum + arr.length, 0)
  keptLines.unshift(`<search_summary>${hitsCount} matches across ${filesCount} file${filesCount === 1 ? '' : 's'}</search_summary>`)
  keptLines.push(...nonHits.slice(0, 3))
  const compressed = keptLines.join('\n')
  return wrap(text, compressed, 'search_aggregate')
}

/** 最通用的行级剪枝：保留首尾 + 高信号行 + 非空行上限。 */
function linePruneCompress(text: string, options: CompressOptions): CompressionReport {
  const lines = text.split(/\r?\n/)
  const target = options.targetRatio ?? 0.4
  const head = options.headTailKeep ?? 8
  const maxTotal = Math.max(20, Math.ceil(lines.length * target))

  const kept: string[] = []
  const seen = new Set<number>()
  for (let i = 0; i < Math.min(head, lines.length); i++) seen.add(i)
  for (let i = Math.max(0, lines.length - head); i < lines.length; i++) seen.add(i)
  // 补充高信号行直到 budget 用满
  for (let i = head; i < lines.length - head && seen.size < maxTotal; i++) {
    if (HIGH_SIGNAL_PATTERNS.some(re => re.test(lines[i]))) seen.add(i)
  }
  let folded = 0
  for (let i = 0; i < lines.length; i++) {
    if (seen.has(i)) {
      if (folded > 0) kept.push(`… <omitted ${folded} low-signal line${folded === 1 ? '' : 's'}> …`)
      kept.push(lines[i])
      folded = 0
    } else {
      folded++
    }
  }
  if (folded > 0) kept.push(`… <omitted ${folded} trailing line${folded === 1 ? '' : 's'}> …`)
  let compressed = kept.join('\n')
  if (options.maxChars && compressed.length > options.maxChars) {
    compressed = compressed.slice(0, options.maxChars) + '\n… <truncated for token budget>'
  }
  return wrap(text, compressed, 'line_prune')
}

function wrap(original: string, compressed: string, method: CompressionReport['method']): CompressionReport {
  const originalLength = original.length
  const compressedLength = compressed.length
  const ratio = originalLength === 0 ? 1 : compressedLength / originalLength
  const body = `<compressed method="${method}" ratio="${ratio.toFixed(2)}">\n${compressed}\n</compressed>`
  return {
    compressed: body,
    originalLength,
    compressedLength: body.length,
    ratio,
    method,
  }
}
