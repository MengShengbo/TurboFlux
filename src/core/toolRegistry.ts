import type { AgentMode, ToolCategory, ToolParameter } from '../shared/agentTypes'
import type { EnhancedToolDef } from '../shared/toolTypes'
import { validateSchemaValue } from './schemaValidation'

const tools: EnhancedToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a bounded file range with line numbers. When offset/limit are omitted, returns up to 2,000 lines within a strict byte budget so normal source files fit in one call without allowing giant or single-line files to consume the context window. Continue from the returned offset or search for a precise range when truncated. Numbered snippets can be pasted directly into edit_file or multi_edit; the editor strips line-number prefixes.',
    category: 'read',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'offset', type: 'number', description: 'Starting line number (1-based). Only provide if the file is too large to read at once or a search identified a precise range.', required: false },
      { name: 'limit', type: 'number', description: 'Number of lines to read. Only provide if the file is too large to read at once or a search identified a precise range.', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    maxResultSizeChars: 64_000,
  },
  {
    name: 'read_file_full',
    description: 'Read a larger bounded preview of a file. Files that exceed the safety budget are truncated with instructions to continue using read_file offset/limit; no file may consume the context window without a hard limit.',
    category: 'read',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    maxResultSizeChars: 96_000,
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
    description: 'Replace a unique snippet in a file. old_content must match exactly after optional read_file line-number prefixes are stripped. Copy numbered read_file snippets directly; do not reread raw content. Use replace_all for renames and multi_edit for multiple changes to one file.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'old_content', type: 'string', description: 'Exact content to replace, optionally copied with read_file line-number prefixes. Whitespace and indentation must otherwise match.', required: true },
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
    description: 'Apply multiple exact-snippet edits to one file atomically. Numbered read_file snippets are accepted directly, so do not reread the file without line numbers. All edits succeed or none are written. If matching is fragile or an old_string fails, switch to replace_file instead of retrying similar snippets.',
    category: 'write',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'edits', type: 'array', description: 'Array of edit steps. Each item is {old_string: string, new_string: string, replace_all?: boolean}. Applied in order.', required: true, schema: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: ['boolean', 'null'] } }, required: ['old_string', 'new_string', 'replace_all'], additionalProperties: false } } },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'apply_patch',
    description: 'Apply a Codex-compatible structured patch containing multiple add, update, move, or delete file operations. Use exact context lines in update hunks; the runtime preflights every hunk and detects concurrent file changes before writing.',
    category: 'write',
    parameters: [
      { name: 'patch', type: 'string', description: "Patch text wrapped in '*** Begin Patch' and '*** End Patch'. Update hunks use '@@', context lines start with a space, removals with '-', and additions with '+'.", required: true },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 20_000,
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
      { name: 'offset', type: 'number', description: 'Skip the first N matches for pagination.', required: false, default: 0 },
      { name: 'head_limit', type: 'number', description: 'Maximum matches to return. Default 50, max 500.', required: false, default: 50 },
      { name: 'context_before', type: 'number', description: 'Context lines before each match.', required: false, default: 0 },
      { name: 'context_after', type: 'number', description: 'Context lines after each match.', required: false, default: 0 },
      { name: 'multiline', type: 'boolean', description: 'Enable multiline regex matching.', required: false, default: false },
      { name: 'file_type', type: 'string', description: 'Ripgrep file type filter such as ts, py, rust, or go.', required: false },
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
    name: 'web_search',
    description: 'Search the public web for current or explicitly external information. Returns compact results with title, URL, snippet, provider, and query. Do not use it as a substitute for source code missing from the active workspace when the user asks about this repository or current project; report the workspace mismatch unless the user requested a remote copy.',
    category: 'read',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query. Include specific product/library/version/error terms when possible.', required: true },
      { name: 'limit', type: 'number', description: 'Maximum number of results to return (default 5, max 10).', required: false, default: 5 },
      { name: 'region', type: 'string', description: 'DuckDuckGo region code such as wt-wt, us-en, cn-zh. Defaults to wt-wt.', required: false, default: 'wt-wt' },
      { name: 'freshness', type: 'string', description: 'Optional freshness hint for future providers. Supported values: day, week, month, year.', required: false, enum: ['day', 'week', 'month', 'year'] },
      { name: 'domains', type: 'array', description: 'Optional domain filters such as ["docs.github.com", "nodejs.org"]. Use for official/source-only searches.', required: false, schema: { type: 'array', items: { type: 'string' } } },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  },
  {
    name: 'tool_search',
    description: 'Search deferred MCP tool metadata and load matching tool schemas for the next model turn. Use this before attempting an MCP tool that is not already visible.',
    category: 'read',
    parameters: [
      { name: 'query', type: 'string', description: 'Intent or capability to search for, such as "issue tracker comments" or "browser screenshot".', required: true },
      { name: 'limit', type: 'number', description: 'Maximum matching tools to load (default 8, maximum 20).', required: false, default: 8 },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
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
      { name: 'tags', type: 'array', description: 'Tags for retrieval (e.g. ["api", "auth", "debugging"]). Max 8 tags.', required: false, schema: { type: 'array', items: { type: 'string' } } },
      { name: 'confidence', type: 'string', description: 'How confident this memory is. "asserted" = user stated directly, "observed" = inferred from behavior, "inferred" = deduced from context.', required: false, default: 'observed', enum: ['asserted', 'observed', 'inferred'] },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
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
    isConcurrencySafe: false,
  },
  {
    name: 'git_status',
    description: 'Read structured repository state: branch, HEAD, upstream divergence, conflicts, staged/unstaged/untracked counts, changed paths, and recent commits.',
    category: 'read',
    parameters: [],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 30_000,
  },
  {
    name: 'git_diff',
    description: 'Read a bounded Git diff without shell quoting. Use working for unstaged changes, staged for the index, or all for both. Untracked file contents are not included.',
    category: 'read',
    parameters: [
      { name: 'scope', type: 'string', description: 'Which changes to compare', required: false, enum: ['working', 'staged', 'all'], default: 'working' },
      { name: 'path', type: 'string', description: 'Optional workspace-relative path filter', required: false },
      { name: 'context_lines', type: 'number', description: 'Diff context lines, from 0 to 50', required: false, default: 3 },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 60_000,
  },
  {
    name: 'git_log',
    description: 'Read recent commit history, optionally limited to one path. Returns stable tab-separated commit metadata.',
    category: 'read',
    parameters: [
      { name: 'limit', type: 'number', description: 'Commit count from 1 to 100', required: false, default: 10 },
      { name: 'path', type: 'string', description: 'Optional workspace-relative path filter', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 30_000,
  },
  {
    name: 'git_show',
    description: 'Inspect one commit or revision with metadata and patch, optionally filtered to one path. Revisions and paths are validated before Git runs.',
    category: 'read',
    parameters: [
      { name: 'revision', type: 'string', description: 'Commit hash or revision such as HEAD, HEAD~2, main, or origin/main', required: true },
      { name: 'path', type: 'string', description: 'Optional workspace-relative path filter', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 60_000,
  },
  {
    name: 'git_stage',
    description: 'Stage an explicit set of workspace paths. Never stages the whole repository implicitly.',
    category: 'write',
    parameters: [
      { name: 'paths', type: 'array', description: 'Workspace-relative paths to stage', required: true, schema: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 1024 } } },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'git_commit',
    description: 'Create a Git commit. When paths are provided, TurboFlux uses an isolated temporary index and refuses paths with pre-existing staged changes. Without paths, commits the current index.',
    category: 'manage',
    parameters: [
      { name: 'message', type: 'string', description: 'Commit message', required: true },
      { name: 'paths', type: 'array', description: 'Optional explicit paths for an isolated commit. Do not stage these paths first; call git_commit(paths) directly.', required: false, schema: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 1024 } } },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'git_restore',
    description: 'Restore explicit workspace paths from a validated Git revision into the working tree. Refuses paths that already contain staged changes.',
    category: 'write',
    parameters: [
      { name: 'paths', type: 'array', description: 'Workspace-relative paths to restore', required: true, schema: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 1024 } } },
      { name: 'source', type: 'string', description: 'Validated source revision; defaults to HEAD', required: false, default: 'HEAD' },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'git_revert',
    description: 'Revert one validated Git revision by creating a new commit. Requires a clean tracked working tree and index.',
    category: 'manage',
    parameters: [
      { name: 'revision', type: 'string', description: 'Commit hash or revision to revert', required: true },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'git_create_branch',
    description: 'Create and switch to a validated branch. Does not force through conflicting working-tree changes.',
    category: 'manage',
    parameters: [
      { name: 'name', type: 'string', description: 'New branch name', required: true },
      { name: 'start_point', type: 'string', description: 'Optional commit or revision to branch from', required: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'git_switch_branch',
    description: 'Switch to an existing validated local branch. Does not use force and Git will refuse changes that would be overwritten.',
    category: 'manage',
    parameters: [
      { name: 'name', type: 'string', description: 'Existing local branch name', required: true },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'git_stash',
    description: 'List, create, apply, or pop Git stashes through validated arguments. Apply/pop may report normal Git conflicts for the agent to resolve.',
    category: 'manage',
    parameters: [
      { name: 'action', type: 'string', description: 'Stash operation', required: true, enum: ['list', 'push', 'apply', 'pop'] },
      { name: 'message', type: 'string', description: 'Optional message for push', required: false },
      { name: 'include_untracked', type: 'boolean', description: 'Include untracked files when pushing', required: false, default: false },
      { name: 'stash', type: 'string', description: 'Validated reference such as stash@{0} for apply/pop', required: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
    maxResultSizeChars: 30_000,
  },
  {
    name: 'git_push',
    description: 'Push one branch to a validated remote without force. This external operation always enters the approval flow unless full-access policy is active.',
    category: 'execute',
    parameters: [
      { name: 'remote', type: 'string', description: 'Remote name', required: false, default: 'origin' },
      { name: 'branch', type: 'string', description: 'Optional local branch name; omit to use Git upstream defaults', required: false },
      { name: 'set_upstream', type: 'boolean', description: 'Set upstream tracking for the pushed branch', required: false, default: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
    maxResultSizeChars: 30_000,
  },
  {
    name: 'run_command',
    description: 'Run a shell command. Long-running dependency installs, builds, tests, and toolchain commands are automatically moved to a durable background session unless run_in_background is explicitly false. Background mode returns a session_id immediately; use read_terminal to monitor it.',
    category: 'execute',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command to execute', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory', required: false },
      { name: 'timeout', type: 'number', description: 'Timeout in milliseconds (foreground only). Default 30000.', required: false, default: 30000 },
      { name: 'env', type: 'object', description: 'Additional environment variables', required: false, schema: { type: 'object', additionalProperties: { type: 'string' } } },
      { name: 'approved', type: 'boolean', description: 'Legacy field; permission gates are enforced by the runtime.', required: false, default: false },
      { name: 'run_in_background', type: 'boolean', description: 'When true, spawn one dedicated command session and return immediately. Long-running commands are selected automatically when omitted. Set false explicitly to force foreground execution.', required: false, default: false },
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
    description: 'Read bounded output from a background command session. Use since_seq for incremental polling; omitted bytes remain available in the durable log.',
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
    name: 'write_terminal',
    description: 'Write raw stdin to a running background terminal. Include a newline in data when submitting a shell command.',
    category: 'execute',
    parameters: [
      { name: 'session_id', type: 'string', description: 'Terminal session id returned by run_command(run_in_background=true) or list_terminals.', required: true },
      { name: 'data', type: 'string', description: 'Exact text or control sequence to write to stdin. Include \\n to submit a command.', required: true },
    ],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
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
      { name: 'dependencies', type: 'array', description: 'Task IDs this task depends on (must be completed first)', required: false, schema: { type: 'array', items: { type: 'string' } } },
      { name: 'order', type: 'number', description: 'Execution order within siblings (lower = earlier)', required: false },
      { name: 'metadata', type: 'object', description: 'Optional metadata: estimatedDuration, relatedFiles, relatedIssue', required: false, schema: { type: 'object', properties: { estimatedDuration: { type: ['number', 'null'] }, relatedFiles: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }, relatedIssue: { type: ['string', 'null'] } }, required: ['estimatedDuration', 'relatedFiles', 'relatedIssue'], additionalProperties: false } },
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
        schema: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['major', 'medium', 'minor'] }, ref: { type: ['string', 'null'] }, parent_id: { type: ['string', 'null'] }, dependencies: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }, order: { type: ['number', 'null'] }, metadata: { type: ['object', 'null'] } }, required: ['title', 'description', 'priority', 'ref', 'parent_id', 'dependencies', 'order', 'metadata'], additionalProperties: false } },
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
      { name: 'options', type: 'array', description: 'Optional list of choices', required: false, schema: { type: 'array', items: { type: 'string' } } },
      { name: 'reason', type: 'string', description: 'Reason for asking (e.g. approval gate)', required: false },
      { name: 'command', type: 'string', description: 'When asking to approve a shell command, include the exact command text here so the UI can render an approval card.', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: false,
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
    name: 'use_skill',
    description: 'Select an enabled project skill for the current turn and record why it applies.',
    category: 'manage',
    parameters: [
      { name: 'skill_id', type: 'string', description: 'Enabled skill identifier.', required: true },
      { name: 'reason', type: 'string', description: 'Optional reason this skill applies.', required: false },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'spawn_agent',
    description: `Launch a specialized subagent to handle a focused task autonomously.

Available types:
- custom agents: Project-specific agents loaded from .turboflux/agents/.

When NOT to use spawn_agent:
- If you know the exact file to read, use read_file directly.
- For a specific symbol definition, use search_symbols.
- For a known string pattern in a known area, use search_content.
- For a tiny known lookup where one targeted search is enough, stay with targeted read/search tools.

Each invocation starts in the background and returns an agent ID immediately. Use read_agent to inspect progress/results, list_agents to discover tasks, and cancel_agent to stop one.
Launch multiple agents concurrently for independent topics and provide a highly specific objective.`,
    category: 'manage',
    parameters: [
      { name: 'agent_type', type: 'string', description: 'Which project-defined agent from .turboflux/agents/ to spawn.', required: true },
      { name: 'objective', type: 'string', description: 'Concrete question or task for the subagent. Be specific — include the area of the codebase, the feature, or the change to review.', required: true },
      { name: 'context', type: 'string', description: 'Optional extra context that helps the subagent (related files, prior findings, constraints).', required: false },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
  {
    name: 'list_agents',
    description: 'List current and recovered background subagent tasks with IDs, types, objectives, and statuses.',
    category: 'read',
    parameters: [],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
  },
  {
    name: 'read_agent',
    description: 'Read a background subagent status, final result, and a page of its persisted transcript.',
    category: 'read',
    parameters: [
      { name: 'agent_id', type: 'string', description: 'Agent ID returned by spawn_agent or list_agents.', required: true },
      { name: 'offset', type: 'number', description: 'Optional zero-based transcript record offset. Defaults to the latest records.', required: false },
      { name: 'limit', type: 'number', description: 'Maximum transcript records to return. Default 20, maximum 200.', required: false, default: 20 },
    ],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    requiredMode: ['vibe', 'plan'],
    maxResultSizeChars: 30_000,
  },
  {
    name: 'cancel_agent',
    description: 'Cancel a running background subagent. Completed and recovered terminal tasks remain readable.',
    category: 'manage',
    parameters: [
      { name: 'agent_id', type: 'string', description: 'Agent ID returned by spawn_agent or list_agents.', required: true },
    ],
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    requiredMode: ['vibe'],
  },
]

export function getAllTools(): EnhancedToolDef[] {
  return tools
}

export function getToolsForMode(mode: AgentMode, options?: { disabledTools?: string[] }): EnhancedToolDef[] {
  const disabledTools = new Set(options?.disabledTools || [])
  return tools.filter(tool => {
    if (disabledTools.has(tool.name)) return false
    if (mode === 'plan' && !tool.isReadOnly) return false
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

type ToolFormatOptions = { disabledTools?: string[]; strict?: boolean }

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
      ...(options?.strict ? { strict: true } : {}),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map(p => [
            p.name,
            parameterSchema(p, options?.strict === true),
          ])
        ),
        required: (options?.strict ? tool.parameters : tool.parameters.filter(p => p.required)).map(p => p.name),
        additionalProperties: false,
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
          parameterSchema(p, false),
        ])
      ),
      required: tool.parameters.filter(p => p.required).map(p => p.name),
      additionalProperties: false,
    },
  }))
}

function parameterSchema(parameter: ToolParameter, strict: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = parameter.schema
    ? strict ? { ...parameter.schema } : relaxNullableRequiredFields(parameter.schema)
    : { type: parameter.type }
  if (parameter.enum) base.enum = parameter.enum
  if (parameter.default !== undefined) base.default = parameter.default
  if (strict && !parameter.required) {
    return { anyOf: [base, { type: 'null' }], description: parameter.description }
  }
  return { ...base, description: parameter.description }
}

function relaxNullableRequiredFields(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...schema }

  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const candidates = schema[keyword]
    if (Array.isArray(candidates)) {
      normalized[keyword] = candidates.map(candidate => (
        candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? relaxNullableRequiredFields(candidate as Record<string, unknown>)
          : candidate
      ))
    }
  }

  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    normalized.items = relaxNullableRequiredFields(schema.items as Record<string, unknown>)
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties)) {
    normalized.additionalProperties = relaxNullableRequiredFields(schema.additionalProperties as Record<string, unknown>)
  }

  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const properties = schema.properties as Record<string, unknown>
    normalized.properties = Object.fromEntries(Object.entries(properties).map(([name, property]) => [
      name,
      property && typeof property === 'object' && !Array.isArray(property)
        ? relaxNullableRequiredFields(property as Record<string, unknown>)
        : property,
    ]))

    if (Array.isArray(schema.required)) {
      normalized.required = schema.required.filter(name => {
        if (typeof name !== 'string') return true
        const property = properties[name]
        return !property || typeof property !== 'object' || Array.isArray(property)
          || !schemaAcceptsNull(property as Record<string, unknown>)
      })
    }
  }

  return normalized
}

function schemaAcceptsNull(schema: Record<string, unknown>): boolean {
  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (declaredTypes.includes('null')) return true

  for (const keyword of ['anyOf', 'oneOf']) {
    const candidates = schema[keyword]
    if (Array.isArray(candidates) && candidates.some(candidate => (
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && schemaAcceptsNull(candidate as Record<string, unknown>)
    ))) {
      return true
    }
  }

  return false
}

export function validateToolArgs(toolName: string, args: Record<string, unknown>): { valid: boolean; error?: string } {
  const tool = getToolByName(toolName)
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolName}` }
  }

  const knownParameters = new Set(tool.parameters.map(parameter => parameter.name))
  const unexpected = Object.keys(args).find(name => !knownParameters.has(name))
  if (unexpected) return { valid: false, error: `Unexpected parameter: ${unexpected}` }

  for (const param of tool.parameters) {
    const value = args[param.name]
    const provided = value !== undefined && value !== null && value !== ''
    if (param.required && !provided) {
      return { valid: false, error: `Missing required parameter: ${param.name}` }
    }
    if (provided) {
      const schema: Record<string, unknown> = param.schema
        ? relaxNullableRequiredFields(param.schema)
        : { type: param.type }
      if (param.enum) schema.enum = param.enum
      const validation = validateSchemaValue(schema, value, param.name)
      if (!validation.valid) return validation
    }
  }

  return { valid: true }
}
