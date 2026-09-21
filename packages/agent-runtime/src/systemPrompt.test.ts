import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './systemPrompt'

describe('buildSystemPrompt', () => {
  it('injects the TurboFlux profile section when provided', () => {
    const prompt = buildSystemPrompt('vibe', {
      profileSystemPrompt: '<turboflux_profile>profile rules</turboflux_profile>',
    })

    expect(prompt).toContain('<turboflux_profile>profile rules</turboflux_profile>')
    expect(prompt).toContain('<identity>')
  })

  it('guides code location through direct search without fixed triggers', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).not.toContain('get_codemap')
    expect(prompt).not.toContain('search_symbols')
    expect(prompt).toContain('there is no mandatory discovery sequence')
    expect(prompt).toContain('output_mode=files')
    expect(prompt).toContain('A partial scan or truncated preview cannot prove absence')
  })

  it('guides current and external facts through web_search', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('web_search')
    expect(prompt).toContain('current or external facts')
  })

  it('requires runtime evidence before selecting an active database', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('identify its active data source from launch configuration')
    expect(prompt).toContain('process command, open-file evidence, or runtime logs')
    expect(prompt).toContain('Never choose the first same-named config or database file')
  })

  it('keeps plan mode context-only without execution guidance', () => {
    const prompt = buildSystemPrompt('plan')

    expect(prompt).toContain('Produce planning only')
    expect(prompt).toContain('read-only project context currently available')
    expect(prompt).toContain('future Vibe-mode step')
    expect(prompt).not.toContain('run_command')
    expect(prompt).not.toContain('read_terminal')
    expect(prompt).not.toContain('write_file')
    expect(prompt).not.toContain('apply_patch')
    expect(prompt).not.toContain('create_tasks')
    expect(prompt).not.toContain('Execute in order after approval')
  })

  it('treats the configured workspace as authoritative', () => {
    const prompt = buildSystemPrompt('vibe', {
      workspacePath: 'C:\\Users\\Administrator',
      workspaceName: 'Administrator',
    })

    expect(prompt).toContain('This path is the authoritative current workspace')
    expect(prompt).toContain('Historical mentions of other projects do not change it')
    expect(prompt).toContain('without supporting tool output')
    expect(prompt).toContain('report the workspace mismatch')
    expect(prompt).toContain('instead of silently substituting a GitHub repository')
  })

  it('does not project TurboFlux product positioning onto open-ended ideas', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).not.toContain('workbench assistant')
    expect(prompt).toContain('are not evidence of what the user wants to build')
    expect(prompt).toContain('Do not infer that the user wants a CLI, coding agent, AI assistant, workbench, or local-first application')
    expect(prompt).toContain("reason from the user's stated goals, audience, constraints, and existing work")
  })

  it('keeps task, edit, and verification work in execution-sized rounds', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('Never spend a model round only creating or updating task state')
    expect(prompt).toContain('Never reread the same region merely to obtain raw text for an edit')
    expect(prompt).toContain('Do not rerun a successful check unless a later edit can affect it')
    expect(prompt).toContain('chain them in one run_command')
    expect(prompt).toContain('Every call must include display_kind and a short display_title')
  })

  it('enforces Codex-style low response density by default', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('<response_density>')
    expect(prompt).toContain('Brevity is a hard output constraint')
    expect(prompt).toContain('stay within 10 rendered lines')
    expect(prompt).toContain('Never turn progress updates into a running investigation diary')
    expect(prompt).toContain('Do not restate the request, enumerate every file or search performed')
    expect(prompt).toContain('only when the user explicitly asks for a detailed explanation')
  })

  it('requires persistent progress updates during multi-step execution', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('progress updates are required')
    expect(prompt).toContain('Do not stay silent until the final answer')
    expect(prompt).toContain('more than three consecutive tool rounds')
    expect(prompt).toContain('what changed or was learned and what happens next')
  })

  it('requires one final delivery while keeping ordinary answers lightweight', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('exactly one visible, self-contained final response')
    expect(prompt).toContain('Never finish on a tool call, hidden reasoning, an empty message, or a progress update')
    expect(prompt).toContain('Keep ordinary question answers direct and free of execution ceremony')
  })

  it('does not let provisional tool commentary masquerade as evidence', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('Never claim a tool found, changed, or proved anything until its result is present')
    expect(prompt).toContain('acknowledge any contradiction')
    expect(prompt).toContain('Never say the user misremembered')
  })

  it('combines every activated skill without a fixed skill-count limit', () => {
    const activatedSkills = Array.from({ length: 6 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      command: `/skill-${index}`,
      description: `Description ${index}`,
      systemPrompt: `<skill-rule-${index}>Full instructions ${index}</skill-rule-${index}>`,
    }))
    const prompt = buildSystemPrompt('vibe', { activatedSkills })

    for (let index = 0; index < activatedSkills.length; index += 1) {
      expect(prompt).toContain(`<skill-rule-${index}>Full instructions ${index}</skill-rule-${index}>`)
    }
  })
})
