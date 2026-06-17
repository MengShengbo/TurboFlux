/**
 * Skills auto-detector.
 * Identifies which Skills should be activated based on user input.
 */

import type { Skill } from '../shared/skillTypes'

export interface SkillMatch {
  skill: Skill
  confidence: number // 0-1
  reason: string
}

/**
 * Detect Skill commands in user input.
 */
export function detectSkillCommands(input: string, skills: Skill[]): SkillMatch[] {
  const matches: SkillMatch[] = []

  for (const skill of skills) {
    const commandPattern = new RegExp(`(^|\\s)${escapeRegex(skill.command)}(\\s|$)`, 'i')
    if (commandPattern.test(input)) {
      matches.push({
        skill,
        confidence: 1.0,
        reason: `User explicitly used the ${skill.command} command`,
      })
    }
  }

  return matches
}

/**
 * Comprehensive detection — returns Skills that should be activated.
 * Only detects explicit commands; other cases are left to the model.
 */
export function detectSkills(input: string, availableSkills: Skill[]): SkillMatch[] {
  const commandMatches = detectSkillCommands(input, availableSkills)
  return commandMatches
}

/**
 * Returns detected skill names for logging/display. No longer instructs the
 * model to call use_skill — skills are invoked as slash commands (user-turn
 * injection) and the model executes the injected prompt directly.
 */
export function generateSkillActivationPrompt(matches: SkillMatch[]): string {
  if (matches.length === 0) return ''
  return matches.map(m => m.skill.name).join(', ')
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
