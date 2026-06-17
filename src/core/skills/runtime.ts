import type { AgentEngine } from '../agentEngine'
import type { LoadedSkill } from './loader'
import { loadAllSkills } from './loader'

/** Skill 统一来源：全部注册到系统级别 */
export type SkillSource = 'system'

export class SkillRuntime {
  private skills: LoadedSkill[] = []
  private activeSkillId: string | null = null

  constructor(private workspacePath: string) {
    this.reload()
  }

  reload(): void {
    this.skills = loadAllSkills(this.workspacePath)
  }

  /**
   * 运行时注册一个 skill（agent 自注册入口）
   * 同 ID 的 skill 后注册覆盖先注册
   */
  registerSkill(skill: LoadedSkill): void {
    const idx = this.skills.findIndex(s => s.id === skill.id)
    if (idx >= 0) {
      this.skills[idx] = skill
    } else {
      this.skills.push(skill)
    }
  }

  /**
   * 批量注册多个 skills（代理注册时使用）
   */
  registerSkills(skills: LoadedSkill[]): void {
    for (const skill of skills) {
      this.registerSkill(skill)
    }
  }

  getAll(): LoadedSkill[] {
    return this.skills
  }

  getById(id: string): LoadedSkill | undefined {
    return this.skills.find(s => s.id === id)
  }

  getByCommand(command: string): LoadedSkill | undefined {
    const normalized = command.startsWith('/') ? command : `/${command}`
    return this.skills.find(s => s.command === normalized)
  }

  activate(skillId: string, engine: AgentEngine): boolean {
    const skill = this.getById(skillId)
    if (!skill) return false

    this.activeSkillId = skillId
    if (skill.systemPrompt) {
      engine.setAppendSystemPrompt(skill.systemPrompt)
    }
    return true
  }

  deactivate(engine: AgentEngine): void {
    this.activeSkillId = null
    engine.setAppendSystemPrompt(undefined)
  }

  getActiveSkillId(): string | null {
    return this.activeSkillId
  }

  getSkillPrompt(skillId: string): string | null {
    const skill = this.getById(skillId)
    if (!skill?.systemPrompt) return null
    return skill.systemPrompt
  }
}
