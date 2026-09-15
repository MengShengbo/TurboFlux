import { describe, it, expect } from 'vitest'
import { PermissionPipeline } from './permissions'

describe('PermissionPipeline', () => {
  it('requires approval for structured Git pushes', () => {
    const pipeline = new PermissionPipeline('agent')
    const args = { remote: 'origin', branch: 'main' }
    expect(pipeline.check('git_push', args).verdict).toBe('ask')
    pipeline.grantRun('git_push', args)
    expect(pipeline.check('git_push', args).verdict).toBe('allow')
  })

  it('allows isolated commits but asks before committing the current index', () => {
    const pipeline = new PermissionPipeline('agent')
    expect(pipeline.check('git_commit', { message: 'safe', paths: ['src/app.ts'] }).verdict).toBe('allow')
    expect(pipeline.check('git_commit', { message: 'all staged changes' }).verdict).toBe('ask')
  })
  describe('dangerous command blocking', () => {
    it('denies rm -rf /', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'rm -rf /' })
      expect(result.verdict).toBe('deny')
      expect(result.decisionId).toMatch(/^policy_/)
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

    it('applies command risk checks to terminal stdin', () => {
      const agentPipeline = new PermissionPipeline('agent')
      const fullPipeline = new PermissionPipeline('full')

      expect(agentPipeline.check('write_terminal', { session_id: 'term-1', data: 'npm publish\n' }).verdict).toBe('ask')
      expect(fullPipeline.check('write_terminal', { session_id: 'term-1', data: 'rm -r -f /\n' }).verdict).toBe('deny')
      expect(agentPipeline.check('write_terminal', { session_id: 'term-1', data: 'y\n' }).verdict).toBe('allow')
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

    it('asks before a raw git commit', () => {
      const pipeline = new PermissionPipeline()
      const result = pipeline.check('run_command', { command: 'git commit -m "feat: add feature"' })
      expect(result.verdict).toBe('ask')
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
      pipeline.grantSession('run_command', { command: 'rm -rf dist' })
      const result = pipeline.check('run_command', { command: 'rm -rf dist' })
      expect(result.verdict).toBe('allow')
    })

    it('clears session grants', () => {
      const pipeline = new PermissionPipeline()
      pipeline.grantSession('run_command', { command: 'rm -rf dist' })
      pipeline.clearSessionGrants()
      const result = pipeline.check('run_command', { command: 'rm -rf dist' })
      expect(result.verdict).toBe('ask')
    })

    it('does not let session grants bypass hard deny commands', () => {
      const pipeline = new PermissionPipeline()
      pipeline.grantSession('run_command', { command: 'rm -rf /' })
      const result = pipeline.check('run_command', { command: 'rm -rf /' })
      expect(result.verdict).toBe('deny')
    })

    it('shares a session grant across file write and edit tools', () => {
      const pipeline = new PermissionPipeline('ask')
      pipeline.grantSession('write_file', { path: 'a.ts', content: 'a' })

      expect(pipeline.check('write_file', { path: 'b.ts', content: 'b' }).verdict).toBe('allow')
      expect(pipeline.check('edit_file', { path: 'c.ts', old_string: 'a', new_string: 'b' }).verdict).toBe('allow')
      expect(pipeline.check('apply_patch', { patch: '*** Begin Patch\n*** End Patch' }).verdict).toBe('allow')
    })

    it('shares a run grant across file write and edit tools', () => {
      const pipeline = new PermissionPipeline('ask')
      pipeline.grantRun('write_file', { path: 'a.ts', content: 'a' })

      expect(pipeline.check('write_file', { path: 'b.ts', content: 'b' }).verdict).toBe('allow')
      expect(pipeline.check('edit_file', { path: 'c.ts', old_string: 'a', new_string: 'b' }).verdict).toBe('allow')
    })

    it('shares an explicit run grant across browser page-changing actions', () => {
      const pipeline = new PermissionPipeline('ask')
      pipeline.grantRun('browser__click', { ref: 'e1' })

      expect(pipeline.check('browser__type', { ref: 'e2', text: 'hello' }).verdict).toBe('allow')
      expect(pipeline.check('browser__drag', { from_x: 1, from_y: 1, to_x: 20, to_y: 20 }).verdict).toBe('allow')
      expect(pipeline.check('files__write', { path: 'a.txt' }).verdict).toBe('ask')
    })

    it('does not reuse computer write approvals across actions', () => {
      const pipeline = new PermissionPipeline('ask')
      const keynote = { app_name: 'Keynote', bundle_id: 'com.apple.Keynote' }
      const pages = { app_name: 'Pages', bundle_id: 'com.apple.Pages' }

      pipeline.grantSession('computer__click', keynote)

      expect(pipeline.check('computer__double_click', keynote).verdict).toBe('ask')
      expect(pipeline.check('computer__type_text', keynote).verdict).toBe('ask')
      expect(pipeline.check('computer__click', pages).verdict).toBe('ask')
    })

    it('does not create reusable computer grants without an app identity', () => {
      const pipeline = new PermissionPipeline('ask')
      pipeline.grantSession('computer__click', {})

      expect(pipeline.check('computer__click', {}).verdict).toBe('ask')
    })

    it('clears run grants independently from session grants', () => {
      const pipeline = new PermissionPipeline('ask')
      pipeline.grantRun('write_file', { path: 'a.ts', content: 'a' })
      pipeline.clearRunGrants()

      expect(pipeline.check('write_file', { path: 'b.ts', content: 'b' }).verdict).toBe('ask')
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

    it('asks before commands that resolve paths outside the workspace dynamically', () => {
      const pipeline = new PermissionPipeline('agent')

      expect(pipeline.check('run_command', { command: 'Get-Content $env:USERPROFILE/.ssh/id_rsa' }).verdict).toBe('ask')
      expect(pipeline.check('run_command', { command: 'cat $HOME/.ssh/id_rsa' }).verdict).toBe('ask')
      expect(pipeline.check('run_command', { command: 'cat ~/private.txt' }).verdict).toBe('ask')
    })

    it('does not reuse an approval for commands with the same long prefix', () => {
      const pipeline = new PermissionPipeline('agent')
      const prefix = `Write-Output ${'x'.repeat(150)}`
      const approved = { command: `${prefix}; curl https://approved.example` }
      const different = { command: `${prefix}; curl https://different.example` }

      pipeline.grantSession('run_command', approved)

      expect(pipeline.check('run_command', approved).verdict).toBe('allow')
      expect(pipeline.check('run_command', different).verdict).toBe('ask')
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
    })

    it('asks before Git-native restore operations', () => {
      const pipeline = new PermissionPipeline('agent')

      expect(pipeline.check('git_restore', { paths: ['src/app.ts'], source: 'HEAD' }).verdict).toBe('ask')
      expect(pipeline.check('git_revert', { revision: 'abc1234' }).verdict).toBe('ask')
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

    it('applies computer approval levels before generic MCP policy', () => {
      const askPipeline = new PermissionPipeline('ask')
      const fullPipeline = new PermissionPipeline('full')

      expect(askPipeline.check('computer__observe', {}).verdict).toBe('allow')
      expect(askPipeline.check('computer__click', { app_name: 'Keynote' }).verdict).toBe('ask')
      expect(fullPipeline.check('computer__click', { app_name: 'Keynote' }).verdict).toBe('ask')
    })

    it('blocks payment actions and ignores reusable grants under full policy', () => {
      const pipeline = new PermissionPipeline('full')
      const args = { app_name: 'Safari', safety_class: 'payment' }

      expect(pipeline.check('computer__click', args).verdict).toBe('deny')
      pipeline.grantSession('computer__click', args)
      expect(pipeline.check('computer__click', args).verdict).toBe('deny')
    })

    it('locally escalates broad observation and ambiguous input despite routine model labels', () => {
      const pipeline = new PermissionPipeline('full')

      expect(pipeline.check('computer__observe', { scope: 'display' }).verdict).toBe('ask')
      expect(pipeline.check('computer__click', { x: 20, y: 30, safety_class: 'routine' }).verdict).toBe('ask')
      expect(pipeline.check('computer__press', { keys: ['ENTER'], safety_class: 'routine' }).verdict).toBe('ask')
      expect(pipeline.check('computer__type_text', { text: 'one\ntwo', safety_class: 'routine' }).verdict).toBe('ask')
      expect(pipeline.check('computer__click', { description: '确认付款', safety_class: 'routine' }).verdict).toBe('deny')
    })

    it('blocks credential entry and unknown computer operations under full policy', () => {
      const pipeline = new PermissionPipeline('full')

      expect(pipeline.check('computer__type_text', { field_type: 'password' }).verdict).toBe('deny')
      expect(pipeline.check('computer__raw_script', { script: 'unsafe()' }).verdict).toBe('deny')
    })

    it.each([
      'rm -r -f /',
      'rm -rf "/"',
      'rm -rf -- /',
      'Remove-Item C:\\ -Recurse -Force',
      'Remove-Item "C:\\" -Recurse -Force',
      'Remove-Item "/" -Recurse -Force',
      'rd /s /q C:\\',
      'rd /s /q "C:\\"',
    ])('full policy blocks root deletion variant: %s', command => {
      const pipeline = new PermissionPipeline('full')
      expect(pipeline.check('run_command', { command }).verdict).toBe('deny')
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
