import { describe, it, expect } from 'vitest'
import { PermissionPipeline } from './permissions'

describe('PermissionPipeline', () => {
  describe('dangerous command blocking', () => {
    it('denies rm -rf /', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'rm -rf /' })
      expect(result.verdict).toBe('deny')
    })

    it('denies format C:', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'format C: /q' })
      expect(result.verdict).toBe('deny')
    })

    it('denies del /s /q C:\\', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'del /s /q C:\\' })
      expect(result.verdict).toBe('deny')
    })

    it('denies mkfs commands', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'mkfs.ext4 /dev/sda1' })
      expect(result.verdict).toBe('deny')
    })

    it('denies dd to disk device', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'dd if=/dev/zero of=/dev/sda bs=1M' })
      expect(result.verdict).toBe('deny')
    })

    it('denies fork bomb', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: ':(){ :|:& };:' })
      expect(result.verdict).toBe('deny')
    })

    it('denies rm -rf /*', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'rm -rf /*' })
      expect(result.verdict).toBe('deny')
    })

    it('denies sudo rm -rf /', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'sudo rm -rf /' })
      expect(result.verdict).toBe('deny')
    })
  })

  describe('high-risk command warnings', () => {
    it('asks before writing to terminal stdin', () => {
      const pipeline = new PermissionPipeline('ask')
      const result = pipeline.check('write_terminal', { session_id: 'term-1', data: 'npm publish\n' })
      expect(result.verdict).toBe('ask')
    })

    it('asks before cancelling a background subagent', () => {
      const pipeline = new PermissionPipeline('ask')
      expect(pipeline.check('cancel_agent', { agent_id: 'runtime_agent_1' }).verdict).toBe('ask')
    })

    it('asks for git push --force', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'git push --force origin main' })
      expect(result.verdict).toBe('ask')
    })

    it('asks for git reset --hard', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'git reset --hard HEAD~3' })
      expect(result.verdict).toBe('ask')
    })

    it('asks for rm -rf', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'rm -rf node_modules' })
      expect(result.verdict).toBe('ask')
    })

    it('asks for DROP TABLE', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'psql -c "DROP TABLE users"' })
      expect(result.verdict).toBe('ask')
    })

    it('asks for npm publish', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'npm publish --access public' })
      expect(result.verdict).toBe('ask')
    })

    it('does not trust model-provided approved=true', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'rm -rf dist', approved: true })
      expect(result.verdict).toBe('ask')
    })
  })

  describe('safe commands', () => {
    it('allows ls', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'ls -la' })
      expect(result.verdict).toBe('allow')
    })

    it('allows npm install', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'npm install express' })
      expect(result.verdict).toBe('allow')
    })

    it('allows git commit', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'git commit -m "feat: add feature"' })
      expect(result.verdict).toBe('allow')
    })

    it('allows non-command tools', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('read_file', { path: 'src/index.ts' })
      expect(result.verdict).toBe('allow')
    })
  })

  describe('session grants', () => {
    it('allows previously granted commands', () => {
      const pipeline = new PermissionPipeline()
      pipeline.grantSession('run_command', 'rm -rf dist')
      const result = pipeline.check('run_command', { command: 'rm -rf dist' })
      expect(result.verdict).toBe('allow')
    })

    it('clears session grants', () => {
      const pipeline = new PermissionPipeline()
      pipeline.grantSession('run_command', 'rm -rf dist')
      pipeline.clearSessionGrants()
      const result = pipeline.check('run_command', { command: 'rm -rf dist' })
      expect(result.verdict).toBe('ask')
    })

    it('does not let session grants bypass hard deny commands', () => {
      const pipeline = new PermissionPipeline()
      pipeline.grantSession('run_command', 'rm -rf /')
      const result = pipeline.check('run_command', { command: 'rm -rf /' })
      expect(result.verdict).toBe('deny')
    })

    it('shares a session grant across file write and edit tools', () => {
      const pipeline = new PermissionPipeline('ask')
      pipeline.grantSession('write_file', JSON.stringify({ path: 'a.ts', content: 'a' }))

      expect(pipeline.check('write_file', { path: 'b.ts', content: 'b' }).verdict).toBe('allow')
      expect(pipeline.check('edit_file', { path: 'c.ts', old_string: 'a', new_string: 'b' }).verdict).toBe('allow')
    })
  })

  describe('approval policies', () => {
    it('asks before MCP tools even when the agent handles low-risk actions', () => {
      const pipeline = new PermissionPipeline('agent')
      expect(pipeline.check('files__read', { path: 'secret.txt' })).toMatchObject({ verdict: 'ask' })
    })

    it('lets the agent continue low-risk workspace changes', () => {
      const pipeline = new PermissionPipeline('agent')

      expect(pipeline.check('write_file', { path: 'src/app.ts', content: 'ok' }).verdict).toBe('allow')
      expect(pipeline.check('run_command', { command: 'npm test' }).verdict).toBe('allow')
    })

    it('asks before network actions in agent mode', () => {
      const pipeline = new PermissionPipeline('agent')

      expect(pipeline.check('run_command', { command: 'curl https://example.com' }).verdict).toBe('ask')
      expect(pipeline.check('run_command', { command: 'git push origin main' }).verdict).toBe('ask')
    })

    it('ask policy asks before write tools', () => {
      const pipeline = new PermissionPipeline('ask')
      const result = pipeline.check('write_file', { path: 'notes.md', content: 'hello' })
      expect(result.verdict).toBe('ask')
    })

    it('ask policy asks before whole-file replacement', () => {
      const pipeline = new PermissionPipeline('ask')
      const result = pipeline.check('replace_file', { path: 'notes.md', content: 'hello' })
      expect(result.verdict).toBe('ask')
    })

    it('ask policy asks before command execution', () => {
      const pipeline = new PermissionPipeline('ask')
      const result = pipeline.check('run_command', { command: 'npm test' })
      expect(result.verdict).toBe('ask')
    })

    it('does not interrupt internal task workflow bookkeeping', () => {
      const pipeline = new PermissionPipeline('ask')

      expect(pipeline.check('create_task', { title: 'Implement UI' }).verdict).toBe('allow')
      expect(pipeline.check('update_task', { task_id: 'task-1', status: 'completed' }).verdict).toBe('allow')
      expect(pipeline.check('create_checkpoint', { label: 'safe point' }).verdict).toBe('allow')
    })

    it('full policy allows ask-level high-risk commands', () => {
      const pipeline = new PermissionPipeline('full')
      const result = pipeline.check('run_command', { command: 'git reset --hard HEAD~1' })
      expect(result.verdict).toBe('allow')
    })

    it('full policy still denies hard-danger commands', () => {
      const pipeline = new PermissionPipeline('full')
      const result = pipeline.check('run_command', { command: 'rm -rf /' })
      expect(result.verdict).toBe('deny')
    })
  })

  describe('custom rules', () => {
    it('applies loaded rules', () => {
      const pipeline = new PermissionPipeline()
      pipeline.loadRules([{
        toolPattern: 'write_file',
        verdict: 'ask',
        reason: 'Project policy: confirm writes',
        source: 'project',
      }])
      const result = pipeline.check('write_file', { path: 'config.json', content: '{}' })
      expect(result.verdict).toBe('ask')
      expect(result.reason).toBe('Project policy: confirm writes')
    })

    it('supports wildcard patterns', () => {
      const pipeline = new PermissionPipeline()
      pipeline.loadRules([{
        toolPattern: 'write_*',
        verdict: 'ask',
        reason: 'All writes need approval',
        source: 'project',
      }])
      const result = pipeline.check('write_file', { path: 'test.ts', content: '' })
      expect(result.verdict).toBe('ask')
    })
  })
})
