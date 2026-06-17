import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { SubAgentDefinition, SubAgentDriver, SubAgentThinking } from '../../shared/subAgentTypes'

// ── Frontmatter 解析 ──────────────────────────────────────────────

interface AgentFrontmatter {
  name?: string
  description?: string
  tools?: string[]
  model?: string
  maxTurns?: number
  maxParallel?: number
  temperature?: number
  thinking?: SubAgentThinking
  color?: string
  skills?: string[]           // 关联的 skill IDs
  maxOutputTokens?: number
}

function parseFrontmatter(content: string): { meta: AgentFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const yamlBlock = match[1]
  const body = match[2]
  const meta: AgentFrontmatter = {}

  let currentKey: string | null = null
  let currentArray: string[] | null = null

  for (const rawLine of yamlBlock.split('\n')) {
    const line = rawLine.replace(/\r$/, '')

    // 数组续行（以 - 开头，且当前有活跃的数组 key）
    if (currentArray && line.match(/^\s*-\s+/)) {
      const val = line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')
      if (val) currentArray.push(val)
      continue
    }

    // 新的 key: value
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue

    // 切换 key 时，保存之前的数组
    if (currentArray && currentKey) {
      ;(meta as any)[currentKey] = currentArray
      currentArray = null
      currentKey = null
    }

    const [, key, rawValue] = kv
    const value = rawValue.trim()

    // 数组类型字段
    if (key === 'tools' || key === 'skills') {
      if (value.startsWith('[')) {
        // 内联数组 [a, b, c]
        try {
          ;(meta as any)[key] = JSON.parse(value)
        } catch {
          ;(meta as any)[key] = value.replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
        }
      } else if (value === '') {
        // 多行数组，后续行以 - 开头
        currentKey = key
        currentArray = []
      } else {
        ;(meta as any)[key] = [value]
      }
      continue
    }

    // 数值类型
    if (key === 'maxTurns' || key === 'maxParallel' || key === 'temperature' || key === 'maxOutputTokens') {
      const num = Number(value)
      if (!isNaN(num)) (meta as any)[key] = num
      continue
    }

    // 字符串类型
    ;(meta as any)[key] = value.replace(/^["']|["']$/g, '')
  }

  // 保存最后一个数组
  if (currentArray && currentKey) {
    ;(meta as any)[currentKey] = currentArray
  }

  return { meta, body }
}

// ── Agent 加载 ────────────────────────────────────────────────────

export interface LoadedAgent extends SubAgentDefinition {
  source: 'project' | 'builtin'
  filePath?: string
  color?: string
  skills?: string[]
}

const VALID_DRIVERS: SubAgentDriver[] = ['deepseek-flash', 'deepseek-reasoner']
const VALID_THINKING: SubAgentThinking[] = ['disabled', 'high', 'max']

function resolveDriver(model?: string): SubAgentDriver {
  if (!model) return 'deepseek-flash'
  if (model === 'deepseek-reasoner' || model === 'reasoner') return 'deepseek-reasoner'
  return 'deepseek-flash'
}

function mapToDefinition(
  meta: AgentFrontmatter,
  body: string,
  source: 'project' | 'builtin',
  filePath?: string,
): LoadedAgent | null {
  if (!meta.name || !meta.description) return null

  const driver = resolveDriver(meta.model)

  return {
    id: meta.name,
    label: meta.name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    description: meta.description,
    driver,
    systemPrompt: body.trim(),
    maxTurns: meta.maxTurns ?? 5,
    maxParallel: meta.maxParallel ?? 4,
    maxOutputTokens: meta.maxOutputTokens,
    temperature: meta.temperature ?? 0,
    thinking: (meta.thinking && VALID_THINKING.includes(meta.thinking)) ? meta.thinking : 'disabled',
    source,
    filePath,
    color: meta.color,
    skills: meta.skills,
  }
}

function loadAgentFromFile(filePath: string, source: 'project' | 'builtin'): LoadedAgent | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const { meta, body } = parseFrontmatter(raw)
    return mapToDefinition(meta, body, source, filePath)
  } catch {
    return null
  }
}

/**
 * 从 .turboflux/agents/ 目录加载所有自定义代理定义
 */
export function loadAgentsFromDir(workspacePath: string): LoadedAgent[] {
  const agentsDir = join(workspacePath, '.turboflux', 'agents')
  if (!existsSync(agentsDir)) return []

  const agents: LoadedAgent[] = []

  try {
    const entries = readdirSync(agentsDir)
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const fullPath = join(agentsDir, entry)
      try {
        if (!statSync(fullPath).isFile()) continue
      } catch {
        continue
      }
      const agent = loadAgentFromFile(fullPath, 'project')
      if (agent) agents.push(agent)
    }
  } catch {
    // directory not readable
  }

  return agents
}

/**
 * 合并硬编码内置代理与动态加载的代理
 * 动态代理（project）优先于同 ID 的内置代理
 */
export function mergeAgentDefinitions(
  builtin: LoadedAgent[],
  dynamic: LoadedAgent[],
): Map<string, LoadedAgent> {
  const map = new Map<string, LoadedAgent>()

  // 先放内置
  for (const def of builtin) {
    map.set(def.id, def)
  }

  // 动态覆盖同 ID
  for (const def of dynamic) {
    map.set(def.id, def)
  }

  return map
}
