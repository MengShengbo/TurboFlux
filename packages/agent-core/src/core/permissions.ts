import type { ApprovalPolicy } from '../shared/agentTypes'
import { browserPermissionGrantGroup } from '../shared/browserToolPresentation'
import { computerPermissionGrantGroup, computerToolApprovalLevel } from '../shared/computerToolPresentation'
import type { PermissionRule, PermissionCheckResult, PermissionVerdict } from '../shared/toolTypes'
import { createHash } from 'node:crypto'

// ─── Dangerous Command Patterns ─────────────────────────────────────────────

interface CommandPattern {
  pattern: RegExp
  verdict: PermissionVerdict
  reason: string
}

const DENY_COMMAND_PATTERNS: CommandPattern[] = [
  { pattern: /\brm\s+(?:(?:--|--[a-z-]+|-[a-z]+)\s+)*(?:"\/"|'\/'|\/)(?:\*|(?=\s|$|[;&|]))/i, verdict: 'deny', reason: 'Destructive: removes filesystem root' },
  { pattern: /\b(?:del|rmdir|rd)\s+(?:(?:\/[a-z]+|-[a-z]+)\s+)*(?:"[A-Z]:\\(?:\*)?"|'[A-Z]:\\(?:\*)?'|[A-Z]:\\(?:\*)?)(?:\s|$|[;&|])/i, verdict: 'deny', reason: 'Destructive: recursively deletes drive root' },
  { pattern: /\bRemove-Item\b(?=[^\r\n;&|]*-(?:Recurse|r)\b)[^\r\n;&|]*(?:"[A-Z]:\\(?:\*)?"|'[A-Z]:\\(?:\*)?'|[A-Z]:\\(?:\*)?|"\/(?:\*)?"|'\/(?:\*)?'|\/(?:\*)?)(?:\s|$|[;&|])/i, verdict: 'deny', reason: 'Destructive: recursively deletes filesystem root' },
  { pattern: /\bformat\s+[A-Z]:/i, verdict: 'deny', reason: 'Destructive: formats entire drive' },
  { pattern: /\bmkfs\b/, verdict: 'deny', reason: 'Destructive: creates filesystem (erases partition)' },
  { pattern: /\bdd\s+if=.*\s+of=\/dev\/[sh]d/, verdict: 'deny', reason: 'Destructive: raw disk write' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, verdict: 'deny', reason: 'Destructive: redirect to raw disk device' },
  { pattern: /:\(\)\s*\{.*:\|:.*&\s*\}\s*;?\s*:/, verdict: 'deny', reason: 'Destructive: fork bomb' },
]

const ASK_COMMAND_PATTERNS: CommandPattern[] = [
  { pattern: /\bgit\s+push\s+.*--force/, verdict: 'ask', reason: 'High-risk: force push may overwrite remote history' },
  { pattern: /\bgit\s+push\b/, verdict: 'ask', reason: 'External action: pushes local changes to a remote repository' },
  { pattern: /\bgit\s+commit\b/, verdict: 'ask', reason: 'Repository state change: use git_commit for isolated, auditable commits' },
  { pattern: /\bgit\s+(?:switch|checkout|merge|rebase|stash|restore)\b/, verdict: 'ask', reason: 'Repository state change: raw Git command may change the working tree or history' },
  { pattern: /\bgit\s+reset\b/, verdict: 'ask', reason: 'Repository state change: reset may alter the index, working tree, or history' },
  { pattern: /\bgit\s+branch\b[^\r\n]*(?:-[dD]|--delete)\b/, verdict: 'ask', reason: 'Repository state change: deletes a Git branch' },
  { pattern: /\bgit\s+reset\s+--hard/, verdict: 'ask', reason: 'High-risk: discards uncommitted changes' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/, verdict: 'ask', reason: 'High-risk: removes untracked files' },
  { pattern: /\bchmod\s+-R\s+777/, verdict: 'ask', reason: 'High-risk: world-writable permissions' },
  { pattern: /\brm\s+-rf\b/, verdict: 'ask', reason: 'High-risk: recursive force delete' },
  { pattern: /\bDROP\s+(TABLE|DATABASE)/i, verdict: 'ask', reason: 'High-risk: drops database objects' },
  { pattern: /\bTRUNCATE\s+TABLE/i, verdict: 'ask', reason: 'High-risk: truncates table data' },
  { pattern: /\bnpm\s+publish\b/, verdict: 'ask', reason: 'High-risk: publishes package to registry' },
  { pattern: /\bRemove-Item\s+.*-Recurse/i, verdict: 'ask', reason: 'High-risk: recursive deletion (PowerShell)' },
  { pattern: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i, verdict: 'ask', reason: 'External action: sends a request over the network' },
  { pattern: /\b(?:ssh|scp|sftp|rsync)\b/i, verdict: 'ask', reason: 'External action: connects to a remote system' },
  { pattern: /(?:\$(?:env:)?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)\b|\$\{(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)\}|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)%|(?:^|\s)~[\\/])/i, verdict: 'ask', reason: 'Dynamic path: command may access files outside the active workspace' },
]

const SESSION_GRANT_GROUPS = new Map<string, string>([
  ['write_file', 'file-write'],
  ['replace_file', 'file-write'],
  ['edit_file', 'file-write'],
  ['multi_edit', 'file-write'],
  ['apply_patch', 'file-write'],
])

// ─── Permission Pipeline ────────────────────────────────────────────────────

export class PermissionPipeline {
  private rules: PermissionRule[] = []
  private sessionGrants = new Map<string, number>()
  private runGrants = new Map<string, number>()
  private decisionSequence = 0

  constructor(private approvalPolicy: ApprovalPolicy = 'agent') {}

  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy
  }

  getApprovalPolicy(): ApprovalPolicy {
    return this.approvalPolicy
  }

  check(toolName: string, args: Record<string, unknown>): PermissionCheckResult {
    const decide = (result: PermissionCheckResult): PermissionCheckResult => ({
      ...result,
      decisionId: `policy_${Date.now().toString(36)}_${(++this.decisionSequence).toString(36)}`,
    })
    if (toolName === 'run_command' || toolName === 'write_terminal') {
      const denyResult = this.checkDenyCommandPatterns(args)
      if (denyResult) return decide(denyResult)
    }

    const computerApprovalLevel = computerToolApprovalLevel(toolName, args)
    if (computerApprovalLevel === 'deny') {
      return decide({ verdict: 'deny', reason: 'Computer action is blocked by the built-in safety policy' })
    }
    if (computerApprovalLevel === 'always') {
      return decide({ verdict: 'ask', reason: 'High-impact computer actions require confirmation every time' })
    }
    if (computerApprovalLevel === 'none') {
      return decide({ verdict: 'allow' })
    }
    if (computerApprovalLevel === 'policy') {
      return decide({ verdict: 'ask', reason: 'Computer actions require a fresh one-time approval before changing an application' })
    }

    if (this.hasSessionGrant(toolName, args)) {
      return decide({ verdict: 'allow', reason: 'Previously approved this session' })
    }

    if (this.hasRunGrant(toolName, args)) {
      return decide({ verdict: 'allow', reason: 'Previously approved for this run' })
    }

    if (toolName.includes('__') && this.approvalPolicy !== 'full') {
      return decide({ verdict: 'ask', reason: 'MCP tools require explicit approval before sharing data or taking action' })
    }

    if (toolName === 'git_push' && this.approvalPolicy !== 'full') {
      return decide({ verdict: 'ask', reason: 'External action: pushes local commits to a remote repository' })
    }

    if (toolName === 'git_commit' && !Array.isArray(args.paths) && this.approvalPolicy !== 'full') {
      return decide({ verdict: 'ask', reason: 'Repository state change: committing the current index may include user-staged files' })
    }

    if ((toolName === 'git_restore' || toolName === 'git_revert') && this.approvalPolicy !== 'full') {
      return decide({ verdict: 'ask', reason: 'Repository recovery operation: confirm the selected Git revision and paths' })
    }

    if (toolName === 'run_command' || toolName === 'write_terminal') {
      const askResult = this.checkAskCommandPatterns(args)
      if (askResult) return decide(askResult)
    }

    for (const rule of this.rules) {
      if (this.matchesRule(rule, toolName, args)) {
        if (this.approvalPolicy === 'full' && rule.verdict === 'ask') continue
        return decide({ verdict: rule.verdict, rule, reason: rule.reason })
      }
    }

    if (this.approvalPolicy === 'ask' && this.requiresApproval(toolName)) {
      return decide({ verdict: 'ask', reason: 'Request approval mode: confirm file changes, commands, and external actions' })
    }

    return decide({ verdict: 'allow' })
  }

  grantSession(toolName: string, args: Record<string, unknown>): void {
    const computerApprovalLevel = computerToolApprovalLevel(toolName, args)
    const group = permissionGrantGroup(toolName, args)
    if (computerApprovalLevel !== null && (computerApprovalLevel !== 'policy' || !group)) return
    if (group) {
      this.sessionGrants.set(`group:${group}`, Date.now())
      return
    }
    this.sessionGrants.set(`${toolName}:${this.computeFingerprint(toolName, args)}`, Date.now())
  }

  grantRun(toolName: string, args: Record<string, unknown>): void {
    const computerApprovalLevel = computerToolApprovalLevel(toolName, args)
    const group = permissionGrantGroup(toolName, args)
    if (computerApprovalLevel !== null && (computerApprovalLevel !== 'policy' || !group)) return
    if (group) {
      this.runGrants.set(`group:${group}`, Date.now())
      return
    }
    this.runGrants.set(`${toolName}:${this.computeFingerprint(toolName, args)}`, Date.now())
  }

  grantCommandPattern(pattern: string): void {
    this.sessionGrants.set(`run_command:pattern:${pattern}`, Date.now())
  }

  loadRules(rules: PermissionRule[]): void {
    this.rules.push(...rules)
    this.rules.sort((a, b) => this.sourcePriority(a.source) - this.sourcePriority(b.source))
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear()
  }

  clearRunGrants(): void {
    this.runGrants.clear()
  }

  private checkDenyCommandPatterns(args: Record<string, unknown>): PermissionCheckResult | null {
    const command = this.commandText(args)
    if (!command) return null

    for (const { pattern, verdict, reason } of DENY_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return { verdict, reason }
      }
    }

    return null
  }

  private checkAskCommandPatterns(args: Record<string, unknown>): PermissionCheckResult | null {
    const command = this.commandText(args)
    if (!command) return null

    if (this.approvalPolicy === 'full') return null

    for (const { pattern, verdict, reason } of ASK_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        const patternKey = `run_command:pattern:${pattern.source}`
        if (this.sessionGrants.has(patternKey)) return null
        return { verdict, reason }
      }
    }

    return null
  }

  private requiresApproval(toolName: string): boolean {
    if (toolName.includes('__')) return true
    return [
      'write_file',
      'replace_file',
      'edit_file',
      'multi_edit',
      'apply_patch',
      'delete_file',
      'remember',
      'forget',
      'run_command',
      'write_terminal',
      'kill_terminal',
      'cancel_agent',
      'git_restore',
      'git_revert',
      'git_stage',
      'git_commit',
      'git_create_branch',
      'git_switch_branch',
      'git_stash',
      'git_push',
    ].includes(toolName)
  }

  private hasSessionGrant(toolName: string, args: Record<string, unknown>): boolean {
    const computerApprovalLevel = computerToolApprovalLevel(toolName, args)
    const group = permissionGrantGroup(toolName, args)
    if (computerApprovalLevel !== null) {
      return computerApprovalLevel === 'policy' && Boolean(group && this.sessionGrants.has(`group:${group}`))
    }
    if (group && this.sessionGrants.has(`group:${group}`)) return true
    const fingerprint = this.computeFingerprint(toolName, args)
    return this.sessionGrants.has(`${toolName}:${fingerprint}`)
  }

  private hasRunGrant(toolName: string, args: Record<string, unknown>): boolean {
    const computerApprovalLevel = computerToolApprovalLevel(toolName, args)
    const group = permissionGrantGroup(toolName, args)
    if (computerApprovalLevel !== null) {
      return computerApprovalLevel === 'policy' && Boolean(group && this.runGrants.has(`group:${group}`))
    }
    if (group && this.runGrants.has(`group:${group}`)) return true
    const fingerprint = this.computeFingerprint(toolName, args)
    return this.runGrants.has(`${toolName}:${fingerprint}`)
  }

  private computeFingerprint(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'run_command') {
      return createHash('sha256').update((args.command as string || '').trim()).digest('hex')
    }
    if (toolName === 'delete_file') {
      return createHash('sha256').update(args.path as string || '').digest('hex')
    }
    return createHash('sha256').update(stableSerialize(args)).digest('hex')
  }

  private commandText(args: Record<string, unknown>): string {
    const value = typeof args.command === 'string'
      ? args.command
      : typeof args.data === 'string'
        ? args.data
        : ''
    return value.trim()
  }

  private matchesRule(rule: PermissionRule, toolName: string, args: Record<string, unknown>): boolean {
    if (rule.toolPattern.includes('*')) {
      const regex = new RegExp('^' + rule.toolPattern.replace(/\*/g, '.*') + '$')
      if (!regex.test(toolName)) return false
    } else if (rule.toolPattern !== toolName) {
      return false
    }

    if (rule.argMatcher && !rule.argMatcher(args)) return false
    return true
  }

  private sourcePriority(source: PermissionRule['source']): number {
    switch (source) {
      case 'builtin': return 0
      case 'project': return 1
      case 'user': return 2
      case 'session': return 3
    }
  }
}

function permissionGrantGroup(toolName: string, args: Record<string, unknown>): string | undefined {
  return computerPermissionGrantGroup(toolName, args)
    || browserPermissionGrantGroup(toolName)
    || SESSION_GRANT_GROUPS.get(toolName)
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

export function createDefaultPipeline(policy?: ApprovalPolicy): PermissionPipeline {
  return new PermissionPipeline(policy)
}
