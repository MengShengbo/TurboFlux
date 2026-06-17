import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Skill } from '../../shared/skillTypes'

export interface LoadedSkill extends Skill {
  source: 'system'
  filePath: string
  rawContent: string
}

interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  allowedTools?: string[]
  category?: string
  icon?: string
}

function parseFrontmatter(content: string): { meta: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const yamlBlock = match[1]
  const body = match[2]
  const meta: SkillFrontmatter = {}

  for (const line of yamlBlock.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (!kv) continue
    const [, key, value] = kv
    if (key === 'allowedTools') {
      try {
        meta.allowedTools = JSON.parse(value)
      } catch {
        meta.allowedTools = value.replace(/[\[\]]/g, '').split(',').map(s => s.trim())
      }
    } else {
      (meta as any)[key] = value.trim()
    }
  }

  return { meta, body }
}

function loadSkillFromDir(dirPath: string, source: 'system'): LoadedSkill | null {
  const skillFile = join(dirPath, 'SKILL.md')
  if (!existsSync(skillFile)) return null

  try {
    const rawContent = readFileSync(skillFile, 'utf-8')
    const { meta, body } = parseFrontmatter(rawContent)
    const dirName = dirPath.split(/[\\/]/).pop() || 'unknown'

    return {
      id: meta.name || dirName,
      name: meta.name || dirName,
      command: `/${meta.name || dirName}`,
      description: meta.description || '',
      category: (meta.category as any) || 'custom',
      icon: meta.icon,
      systemPrompt: body.trim(),
      source,
      filePath: skillFile,
      rawContent,
    }
  } catch {
    return null
  }
}

function scanDirectory(basePath: string, source: 'system'): LoadedSkill[] {
  if (!existsSync(basePath)) return []
  const skills: LoadedSkill[] = []

  try {
    const entries = readdirSync(basePath)
    for (const entry of entries) {
      const fullPath = join(basePath, entry)
      if (statSync(fullPath).isDirectory()) {
        const skill = loadSkillFromDir(fullPath, source)
        if (skill) skills.push(skill)
      }
    }
  } catch {
    // directory not readable
  }

  return skills
}

export function loadAllSkills(workspacePath: string): LoadedSkill[] {
  const projectSkills = scanDirectory(join(workspacePath, '.turboflux', 'skills'), 'system')
  const userSkills = scanDirectory(join(homedir(), '.turboflux', 'skills'), 'system')

  // Deduplicate: project skills override user skills with same id
  const seen = new Set<string>()
  const result: LoadedSkill[] = []

  for (const skill of projectSkills) {
    seen.add(skill.id)
    result.push(skill)
  }
  for (const skill of userSkills) {
    if (!seen.has(skill.id)) {
      seen.add(skill.id)
      result.push(skill)
    }
  }

  return result
}
