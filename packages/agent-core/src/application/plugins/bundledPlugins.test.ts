import { describe, expect, it } from 'vitest'
import { BUNDLED_PLUGINS } from './bundledPlugins'

describe('bundled plugins', () => {
  it('ships the local office suite as a declarative bundled plugin', () => {
    expect(BUNDLED_PLUGINS).toHaveLength(2)
    const office = BUNDLED_PLUGINS.find(entry => entry.manifest.id === 'turboflux.office-workagent')
    expect(office).toMatchObject({
      enabledByDefault: true,
      manifest: {
        id: 'turboflux.office-workagent',
        name: '全能办公工作代理',
        permissions: [],
      },
    })
    expect(office?.manifest.main).toBeUndefined()
    expect(office?.manifest.contributes?.skills).toHaveLength(7)
    expect(Object.keys(office?.promptFiles || {})).toHaveLength(7)
  })

  it('includes Design Atlas locally without enabling its workflows by default', () => {
    const atlas = BUNDLED_PLUGINS.find(entry => entry.manifest.id === 'turboflux.design-atlas')
    expect(atlas).toMatchObject({
      enabledByDefault: false,
      manifest: {
        id: 'turboflux.design-atlas',
        name: '设计图谱',
        permissions: [],
      },
    })
    expect(atlas?.manifest.main).toBeUndefined()
    expect(atlas?.manifest.contributes?.skills).toHaveLength(4)
    expect(atlas?.manifest.contributes?.agents).toHaveLength(3)
    expect(atlas?.manifest.contributes?.workflows).toEqual([
      expect.objectContaining({
        id: 'design-atlas',
        name: '设计方向探索',
        description: '隔离式深度调研、方向数量抽卡、真实截图画廊与编号选型。',
        skillId: 'design-atlas',
        stages: ['research-gate', 'direction-count', 'direction-gallery'],
        checkpoints: [expect.objectContaining({
          stage: 'direction-count',
          renderer: 'count',
          trigger: expect.objectContaining({
            tools: expect.arrayContaining(['write_file', 'replace_file']),
            endsWith: '/premise.md',
          }),
          blockBeforeTrigger: expect.arrayContaining(['create_tasks']),
          choices: expect.arrayContaining([
            expect.objectContaining({ id: '1' }),
            expect.objectContaining({ id: '20' }),
          ]),
          input: { type: 'number', min: 1, max: 20, label: '自定义数量', placeholder: '1–20' },
        })],
      }),
    ])
    expect(Object.keys(atlas?.promptFiles || {})).toHaveLength(4)
    const atlasPrompt = atlas?.promptFiles?.['skills/design-atlas/SKILL.md'] || ''
    expect(atlasPrompt).toContain('一次最多让多模态上下文接收 3 张参考图')
    expect(atlasPrompt).toContain('等待宿主自动打开 direction-count Surface')
    expect(atlasPrompt).not.toContain('retry_agent')
    expect(atlas?.promptFiles?.['skills/direction-synthesis/SKILL.md']).toContain('七个核心轴中的四个轴')
  })
})
