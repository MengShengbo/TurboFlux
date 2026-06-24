import type { AgentMode, ToolCategory, ToolParameter } from '../shared/agentTypes'
import type { EnhancedToolDef } from '../shared/toolTypes'

const tools: EnhancedToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a file or line-range slice. Defaults to the first 180 lines when limit is omitted. Output is line-numbered (cat -n style). Continue with offset/limit. Use read_file_full only when exact complete content is required.',
    category: 'read',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'offset', type: 'number', description: 'Starting line number (1-based)', required: false },
      { name: 'limit', type: 'number', description: 'Number of lines to read', required: false },
      { name: 'with_line_numbers', type: 'boolean', description: 'When true (default), prefix each line with its 1-based line number followed by "\u2192". Set false for raw content.', required: false, default: true },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    maxResultSizeChars: Infinity,
  },
  {
    name: 'read_file_full',
    description: 'Read the entire file in one call. Prefer this when a whole-file rewrite or full-file audit needs exact complete contents. Avoid for very large files unless full contents are truly necessary.',
    category: 'read',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'with_line_numbers', type: 'boolean', description: 'When true, prefix each line with its 1-based line number followed by "\u2192". Default false for raw complete content.', required: false, default: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    maxResultSizeChars: Infinity,
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite a file when creation is intended. For replacing an existing file after reading it, prefer replace_file.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'content', type: 'string', description: 'File content', required: true },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'replace_file',
    description: 'Replace an existing file with complete new contents. Use when targeted edit_file matching is fragile, many sections change, or a whole-file rewrite is simpler. Read the file first, preferably with read_file_full.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'Existing file path (relative to workspace root)', required: true },
      { name: 'content', type: 'string', description: 'Complete replacement file content', required: true },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'edit_file',
    description: 'Replace a unique snippet in a file. old_content must match exactly (incl. whitespace). Use replace_all for renames. Prefer multi_edit for multiple changes to the same file.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'old_content', type: 'string', description: 'Exact content to replace. Must match the file byte-for-byte (incl. indentation).', required: true },
      { name: 'new_content', type: 'string', description: 'Replacement content. Must differ from old_content.', required: true },
      { name: 'replace_all', type: 'boolean', description: 'When true, replace every occurrence of old_content. Default false (requires unique match). Use for variable/identifier renames.', required: false, default: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'multi_edit',
    description: 'Apply multiple exact-snippet edits to one file atomically. All succeed or none are written. If matching is fragile or an old_string fails, switch to replace_file with complete final content instead of retrying similar snippets.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'edits', type: 'array', description: 'Array of edit steps. Each item is {old_string: string, new_string: string, replace_all?: boolean}. Applied in order.', required: true },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'delete_file',
    description: 'Delete a file at the specified path. This operation is irreversible — use with caution.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'File path to delete (relative to workspace root)', required: true },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in the specified directory.',
    category: 'read',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory path (relative to workspace root)', required: true },
      { name: 'recursive', type: 'boolean', description: 'Whether to recursively list subdirectories', required: false, default: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'search_files',
    description: 'Search for candidate files by name using glob patterns across the workspace (e.g. **/*.ts).',
    category: 'read',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Glob search pattern (e.g. **/*.ts)', required: true },
      { name: 'path', type: 'string', description: 'Search starting path', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'search_content',
    description: 'Regex search file contents with snippet windows. Default case-insensitive.',
    category: 'read',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Regular expression search pattern', required: true },
      { name: 'path', type: 'string', description: 'Search path', required: false },
      { name: 'file_pattern', type: 'string', description: 'File name filter pattern (e.g. *.ts)', required: false },
      { name: 'case_sensitive', type: 'boolean', description: 'When true, match exact case. Defaults to false (case-insensitive).', required: false, default: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'search_symbols',
    description: 'Search code symbols with a lightweight lexical source scan (functions, classes, interfaces, constants).',
    category: 'read',
    parameters: [
      { name: 'query', type: 'string', description: 'Symbol query or partial name', required: true },
      { name: 'path', type: 'string', description: 'Optional path filter relative to workspace root', required: false },
      { name: 'symbol_kind', type: 'string', description: 'Optional symbol kind filter', required: false, enum: ['class', 'function', 'interface', 'type', 'enum', 'constant'] },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'get_codemap',
    description: 'Generate a hierarchical project codemap. Cheap first-pass before read_file drilling.',
    category: 'read',
    parameters: [
      { name: 'query', type: 'string', description: 'Question or feature area to map', required: true },
      { name: 'path', type: 'string', description: 'Optional path filter relative to workspace root', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'list_memories',
    description: 'List workspace long-term memories (rules, strategies, pitfalls).',
    category: 'read',
    parameters: [
      { name: 'query', type: 'string', description: 'Optional search query. Matches memory text, tags, and metadata.', required: false },
      { name: 'kind', type: 'string', description: 'Filter by memory kind.', required: false, enum: ['rule', 'fact', 'preference', 'episode', 'todo', 'verdict', 'strategy', 'pitfall', 'workflow'] },
      { name: 'scope', type: 'string', description: 'Filter by scope.', required: false, enum: ['global', 'workspace_shared', 'workspace_private', 'conversation'] },
      { name: 'limit', type: 'number', description: 'Maximum number of entries to return (default 50, max 200).', required: false, default: 50 },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'remember',
    description: 'Store a memory (project knowledge, strategy, pitfall, preference). Survives across conversations; deduplicated automatically.',
    category: 'write',
    parameters: [
      { name: 'text', type: 'string', description: 'The memory content to store (≤ 500 chars). Should be atomic, actionable, and generalizable.', required: true },
      { name: 'kind', type: 'string', description: 'Memory type. Use "fact" for project knowledge, "strategy" for learned approaches, "pitfall" for things to avoid, "workflow" for procedural steps, "preference" for user style preferences.', required: false, default: 'fact', enum: ['fact', 'strategy', 'pitfall', 'workflow', 'preference', 'episode'] },
      { name: 'tags', type: 'array', description: 'Tags for retrieval (e.g. ["api", "auth", "debugging"]). Max 8 tags.', required: false },
      { name: 'confidence', type: 'string', description: 'How confident this memory is. "asserted" = user stated directly, "observed" = inferred from behavior, "inferred" = deduced from context.', required: false, default: 'observed', enum: ['asserted', 'observed', 'inferred'] },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'forget',
    description: 'Soft-delete a memory by marking it rejected. Excluded from future retrieval.',
    category: 'write',
    parameters: [
      { name: 'id', type: 'string', description: 'The memory id to forget (from list_memories results).', required: true },
      { name: 'reason', type: 'string', description: 'Brief reason for forgetting (stored for audit trail).', required: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'run_command',
    description: 'Run a shell command (foreground by default). Set run_in_background for dev servers/watch mode. High-risk commands trigger a user permission gate.',
    category: 'execute',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command to execute', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory', required: false },
      { name: 'timeout', type: 'number', description: 'Timeout in milliseconds (foreground only). Default 30000.', required: false, default: 30000 },
      { name: 'env', type: 'object', description: 'Additional environment variables', required: false },
      { name: 'approved', type: 'boolean', description: 'Legacy field; permission gates are enforced by the runtime.', required: false, default: false },
      { name: 'run_in_background', type: 'boolean', description: 'When true, spawn the command in a dedicated agent terminal session and return immediately with a session_id. Use for dev servers, watch processes, test-watch. Default false.', required: false, default: false },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 30_000,
    isConcurrencySafeFor: (input) => {
      const cmd = (input.command as string || '').trim()
      const readOnlyPrefixes = ['ls ', 'ls\t', 'dir ', 'dir\t', 'cat ', 'head ', 'tail ', 'echo ', 'pwd', 'which ', 'where ', 'type ', 'git status', 'git log', 'git diff', 'git branch', 'git show', 'node --version', 'npm list', 'Get-ChildItem', 'Get-Content', 'Get-Location']
      return readOnlyPrefixes.some(p => cmd === p.trimEnd() || cmd.startsWith(p))
    },
  },
  {
    name: 'read_terminal',
    description: 'Read output from a background terminal session. Use since_seq to poll only new output.',
    category: 'read',
    parameters: [
      { name: 'session_id', type: 'string', description: 'Terminal session id (returned by run_command(run_in_background=true) or list_terminals).', required: true },
      { name: 'tail_lines', type: 'number', description: 'Number of trailing lines to return. Default 200. Set 0 for the entire buffer (or new chunks when since_seq is set).', required: false, default: 200 },
      { name: 'since_seq', type: 'number', description: 'Return only output chunks with seq > since_seq. Use the last_seq value from a previous read_terminal response to poll for new output without re-reading the full buffer.', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'kill_terminal',
    description: 'Stop a background terminal session. Default: graceful interrupt (Ctrl+C). Use hard=true for immediate kill.',
    category: 'execute',
    parameters: [
      { name: 'session_id', type: 'string', description: 'Terminal session id to stop.', required: true },
      { name: 'hard', type: 'boolean', description: 'When true, kill the shell process directly instead of sending an interrupt. Default false.', required: false, default: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'list_terminals',
    description: 'List active background terminal sessions with status, cwd, and last command.',
    category: 'read',
    parameters: [],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'create_task',
    description: 'Create a single task. Prefer create_tasks for 2+ tasks.',
    category: 'manage',
    parameters: [
      { name: 'title', type: 'string', description: 'Task title', required: true },
      { name: 'description', type: 'string', description: 'Task description', required: true },
      { name: 'priority', type: 'string', description: 'Task priority level', required: true, enum: ['major', 'medium', 'minor'] },
      { name: 'parent_id', type: 'string', description: 'Parent task ID', required: false },
      { name: 'dependencies', type: 'array', description: 'Task IDs this task depends on (must be completed first)', required: false },
      { name: 'order', type: 'number', description: 'Execution order within siblings (lower = earlier)', required: false },
      { name: 'metadata', type: 'object', description: 'Optional metadata: estimatedDuration, relatedFiles, relatedIssue', required: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'create_tasks',
    description: 'Create multiple tasks in one call. Tasks are created in array order; use ref to cross-reference within the same call.',
    category: 'manage',
    parameters: [
      {
        name: 'tasks',
        type: 'array',
        description: 'Array of task definitions. Each item: { title, description, priority ("major"|"medium"|"minor"), ref? (local label to reference within this call), parent_id? (real task id or a `ref` from earlier in this same array), dependencies? (array of ids or local refs), order?, metadata? }.',
        required: true,
      },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'update_task',
    description: 'Update task status or progress.',
    category: 'manage',
    parameters: [
      { name: 'task_id', type: 'string', description: 'Task ID', required: true },
      { name: 'status', type: 'string', description: 'New status', required: false, enum: ['pending', 'in_progress', 'completed', 'failed'] },
      { name: 'progress', type: 'number', description: 'Progress percentage (0-100)', required: false },
      { name: 'error', type: 'string', description: 'Error message (only for failed status)', required: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'add_task_dependency',
    description: 'Add a task dependency. Automatically prevents cycles.',
    category: 'manage',
    parameters: [
      { name: 'task_id', type: 'string', description: 'Task that depends on another', required: true },
      { name: 'dependency_id', type: 'string', description: 'Task that must be completed first', required: true },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'remove_task_dependency',
    description: 'Remove a dependency from a task.',
    category: 'manage',
    parameters: [
      { name: 'task_id', type: 'string', description: 'Task to remove dependency from', required: true },
      { name: 'dependency_id', type: 'string', description: 'Dependency to remove', required: true },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'list_tasks',
    description: 'List all tasks in the current session and their status.',
    category: 'manage',
    parameters: [
      { name: 'parent_id', type: 'string', description: 'Filter by parent task', required: false },
      { name: 'status', type: 'string', description: 'Filter by status', required: false, enum: ['pending', 'in_progress', 'completed', 'failed'] },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question or request confirmation.',
    category: 'communicate',
    parameters: [
      { name: 'question', type: 'string', description: 'Question to ask the user', required: true },
      { name: 'options', type: 'array', description: 'Optional list of choices', required: false },
      { name: 'reason', type: 'string', description: 'Reason for asking (e.g. approval gate)', required: false },
      { name: 'command', type: 'string', description: 'When asking to approve a shell command, include the exact command text here so the UI can render an approval card.', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'notify_user',
    description: 'Send a non-blocking notification to the user. Used for progress updates, status changes, etc. — does not require a user response.',
    category: 'communicate',
    parameters: [
      { name: 'message', type: 'string', description: 'Notification content', required: true },
      { name: 'type', type: 'string', description: 'Notification type', required: false, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'create_checkpoint',
    description: 'Create a local history checkpoint.',
    category: 'manage',
    parameters: [
      { name: 'message', type: 'string', description: 'Checkpoint description', required: true },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'spawn_agent',
    description: `Launch a specialized subagent to handle a focused task autonomously.

Available types:
- fast_context: Fast issue-localization code map. Use when locating an unfamiliar feature/bug/UI area, when multiple keywords/routes may be involved, or when narrow read/search attempts failed. It returns ranked candidate files, evidence roles, confidence, and line ranges.
- explorer: Deep investigation of a feature, call chain, or subsystem. Reads implementations and follows imports across multiple files.
- reviewer: Code quality/security/bug review of a specific file or feature area.
- git_inspector: Analyze recent git changes — what was modified, why, and what the diff shows.

When NOT to use spawn_agent:
- If you know the exact file to read, use read_file directly.
- For a specific symbol definition, use search_symbols.
- For a known string pattern in a known area, use search_content.
- For a tiny known lookup where one targeted search is enough, stay with targeted read/search tools.

Launch multiple agents concurrently for independent topics — use parallel tool calls.
Each invocation is stateless. Provide a highly specific objective.`,
    category: 'read',
    parameters: [
      { name: 'agent_type', type: 'string', description: 'Which subagent to spawn. Includes built-in types (fast_context, explorer, reviewer) and any custom agents from .turboflux/agents/.', required: true },
      { name: 'objective', type: 'string', description: 'Concrete question or task for the subagent. Be specific — include the area of the codebase, the feature, or the change to review.', required: true },
      { name: 'context', type: 'string', description: 'Optional extra context that helps the subagent (related files, prior findings, constraints).', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'generate_change_summary',
    description: 'Generate a summary card for completed work: changes, findings, key files, and unresolved gaps.',
    category: 'communicate',
    parameters: [
      { name: 'files_changed', type: 'array', description: 'List of changed files', required: true },
      { name: 'summary', type: 'string', description: 'Change summary', required: true },
      { name: 'reason', type: 'string', description: 'Reason for the change', required: false },
      { name: 'risks', type: 'string', description: 'Potential risks', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
  },
]

export function getAllTools(): EnhancedToolDef[] {
  return tools
}

export function getToolsForMode(mode: AgentMode, options?: { disabledTools?: string[] }): EnhancedToolDef[] {
  const disabledTools = new Set(options?.disabledTools || [])
  return tools.filter(tool => {
    if (disabledTools.has(tool.name)) return false
    if (!tool.requiredMode) return true
    return tool.requiredMode.includes(mode)
  })
}

export function getToolByName(name: string): EnhancedToolDef | undefined {
  return tools.find(t => t.name === name)
}

export function getToolsByCategory(category: ToolCategory): EnhancedToolDef[] {
  return tools.filter(t => t.category === category)
}

type ToolFormatOptions = { disabledTools?: string[] }

function selectTools(mode: AgentMode, options?: ToolFormatOptions): EnhancedToolDef[] {
  return getToolsForMode(mode, options)
}

export function toolsToOpenAIFormat(mode: AgentMode, options?: ToolFormatOptions): object[] {
  const modeTools = selectTools(mode, options)
  return modeTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map(p => [
            p.name,
            {
              type: p.type,
              description: p.description,
              ...(p.enum ? { enum: p.enum } : {}),
              ...(p.default !== undefined ? { default: p.default } : {}),
            },
          ])
        ),
        required: tool.parameters.filter(p => p.required).map(p => p.name),
      },
    },
  }))
}

export function toolsToAnthropicFormat(mode: AgentMode, options?: ToolFormatOptions): object[] {
  const modeTools = selectTools(mode, options)
  return modeTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        tool.parameters.map(p => [
          p.name,
          {
            type: p.type,
            description: p.description,
            ...(p.enum ? { enum: p.enum } : {}),
            ...(p.default !== undefined ? { default: p.default } : {}),
          },
        ])
      ),
      required: tool.parameters.filter(p => p.required).map(p => p.name),
    },
  }))
}

function paramTypeMatches(declared: ToolParameter['type'], value: unknown): boolean {
  switch (declared) {
    case 'string':  return typeof value === 'string'
    case 'number':  return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array':   return Array.isArray(value)
    case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value)
    default:        return true
  }
}

export function validateToolArgs(toolName: string, args: Record<string, unknown>): { valid: boolean; error?: string } {
  const tool = getToolByName(toolName)
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolName}` }
  }

  for (const param of tool.parameters) {
    const value = args[param.name]
    const provided = value !== undefined && value !== null && value !== ''
    if (param.required && !provided) {
      return { valid: false, error: `Missing required parameter: ${param.name}` }
    }
    if (provided && !paramTypeMatches(param.type, value)) {
      return {
        valid: false,
        error: `Invalid type for ${param.name}: expected ${param.type}, got ${Array.isArray(value) ? 'array' : typeof value}`,
      }
    }
    if (param.enum && provided) {
      if (typeof value !== 'string' || !param.enum.includes(value)) {
        return { valid: false, error: `Invalid value for ${param.name}: ${String(value)}. Expected one of: ${param.enum.join(', ')}` }
      }
    }
  }

  return { valid: true }
}
