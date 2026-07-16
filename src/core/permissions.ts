import type { ApprovalPolicy } from '../shared/agentTypes'
import type { PermissionRule, PermissionCheckResult, PermissionVerdict } from '../shared/toolTypes'

// ─── Dangerous Command Patterns ─────────────────────────────────────────────

interface CommandPattern {
  pattern: RegExp
  verdict: PermissionVerdict
  reason: string
}

const DENY_COMMAND_PATTERNS: CommandPattern[] = [
  { pattern: /\brm\s+(-[a-z]*f[a-z]*\s+)?\/(\/?\s*$|\*)/, verdict: 'deny', reason: 'Destructive: removes filesystem root' },
  { pattern: /^\s*del\s+\/s\s+\/q\s+[A-Z]:\\\s*$/i, verdict: 'deny', reason: 'Destructive: recursively deletes drive root' },
  { pattern: /\bformat\s+[A-Z]:/i, verdict: 'deny', reason: 'Destructive: formats entire drive' },
  { pattern: /\bmkfs\b/, verdict: 'deny', reason: 'Destructive: creates filesystem (erases partition)' },
  { pattern: /\bdd\s+if=.*\s+of=\/dev\/[sh]d/, verdict: 'deny', reason: 'Destructive: raw disk write' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, verdict: 'deny', reason: 'Destructive: redirect to raw disk device' },
  { pattern: /:\(\)\s*\{.*:\|:.*&\s*\}\s*;?\s*:/, verdict: 'deny', reason: 'Destructive: fork bomb' },
]

const ASK_COMMAND_PATTERNS: CommandPattern[] = [
  { pattern: /\bgit\s+push\s+.*--force/, verdict: 'ask', reason: 'High-risk: force push may overwrite remote history' },
  { pattern: /\bgit\s+push\b/, verdict: 'ask', reason: 'External action: pushes local changes to a remote repository' },
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
]

const SESSION_GRANT_GROUPS = new Map<string, string>([
  ['write_file', 'file-write'],
  ['replace_file', 'file-write'],
  ['edit_file', 'file-write'],
  ['multi_edit', 'file-write'],
])

// ─── Permission Pipeline ────────────────────────────────────────────────────

export class PermissionPipeline {
  private rules: PermissionRule[] = []
  private sessionGrants = new Map<string, number>()

  constructor(private approvalPolicy: ApprovalPolicy = 'agent') {}

  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy
  }

  getApprovalPolicy(): ApprovalPolicy {
    return this.approvalPolicy
  }

  check(toolName: string, args: Record<string, unknown>): PermissionCheckResult {
    if (toolName === 'run_command') {
      const denyResult = this.checkDenyCommandPatterns(args)
      if (denyResult) return denyResult
    }

    if (this.hasSessionGrant(toolName, args)) {
      return { verdict: 'allow', reason: 'Previously approved this session' }
    }

    if (toolName.includes('__') && this.approvalPolicy !== 'full') {
      return { verdict: 'ask', reason: 'MCP tools require explicit approval before sharing data or taking action' }
    }

    if (toolName === 'run_command') {
      const askResult = this.checkAskCommandPatterns(args)
      if (askResult) return askResult
    }

    for (const rule of this.rules) {
      if (this.matchesRule(rule, toolName, args)) {
        if (this.approvalPolicy === 'full' && rule.verdict === 'ask') continue
        return { verdict: rule.verdict, rule, reason: rule.reason }
      }
    }

    if (this.approvalPolicy === 'ask' && this.requiresApproval(toolName)) {
      return { verdict: 'ask', reason: 'Request approval mode: confirm file changes, commands, and external actions' }
    }

    return { verdict: 'allow' }
  }

  grantSession(toolName: string, argsFingerprint: string): void {
    const group = SESSION_GRANT_GROUPS.get(toolName)
    if (group) {
      this.sessionGrants.set(`group:${group}`, Date.now())
      return
    }
    this.sessionGrants.set(`${toolName}:${argsFingerprint}`, Date.now())
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

  private checkDenyCommandPatterns(args: Record<string, unknown>): PermissionCheckResult | null {
    const command = (args.command as string || '').trim()
    if (!command) return null

    for (const { pattern, verdict, reason } of DENY_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return { verdict, reason }
      }
    }

    return null
  }

  private checkAskCommandPatterns(args: Record<string, unknown>): PermissionCheckResult | null {
    const command = (args.command as string || '').trim()
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
      'delete_file',
      'remember',
      'forget',
      'run_command',
      'kill_terminal',
      'restore_checkpoint',
      'prune_checkpoints',
    ].includes(toolName)
  }

  private hasSessionGrant(toolName: string, args: Record<string, unknown>): boolean {
    const group = SESSION_GRANT_GROUPS.get(toolName)
    if (group && this.sessionGrants.has(`group:${group}`)) return true
    const fingerprint = this.computeFingerprint(toolName, args)
    return this.sessionGrants.has(`${toolName}:${fingerprint}`)
  }

  private computeFingerprint(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'run_command') {
      return (args.command as string || '').trim().slice(0, 100)
    }
    if (toolName === 'delete_file') {
      return (args.path as string || '')
    }
    return JSON.stringify(args).slice(0, 200)
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

export function createDefaultPipeline(policy?: ApprovalPolicy): PermissionPipeline {
  return new PermissionPipeline(policy)
}
