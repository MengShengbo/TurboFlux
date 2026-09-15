import { describe, expect, it } from 'vitest'
import { profileColor, profileSwitcherMarkup } from './profileSwitcher'

function profile(id: string, displayName: string, active = false): DesktopLocalProfileSummary {
  return {
    id,
    displayName,
    state: 'ready',
    active,
    createdAt: 1,
    updatedAt: 1,
    imported: false,
    locked: false,
    conversationCount: active ? 18 : 4,
    boundWorkspaceCount: 1,
    unboundWorkspaceCount: active ? 0 : 1,
    storageBytes: 1,
    deviceStateCount: 0,
  }
}

describe('profile switcher presentation', () => {
  it('separates current, other and global profile actions', () => {
    const markup = profileSwitcherMarkup({
      activeProfileId: 'profile-main',
      transitionBlocker: null,
      profiles: [profile('profile-main', '默认资料', true), profile('profile-study', '学习')],
    })

    expect(markup).toContain('正在使用')
    expect(markup).toContain('--active-profile-color:')
    expect(markup).toContain('其他用户')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('1 个工作区待定位')
    expect(markup).toContain('新建用户资料')
    expect(markup).toContain('导入 TurboFlux 资料包')
    expect(markup).toContain('管理用户资料…')
    expect(markup).not.toContain('window.confirm')
  })

  it('uses an explicit avatar color or a stable derived palette color', () => {
    const explicit = { ...profile('profile-explicit', '明确'), avatar: { kind: 'color', value: '#123abc' } } as DesktopLocalProfileSummary
    expect(profileColor(explicit)).toBe('#123abc')
    expect(profileColor(profile('profile-stable', '稳定'))).toBe(profileColor(profile('profile-stable', '稳定')))
  })

  it('renders a lifecycle blocker in the switcher instead of hiding it in a toast', () => {
    const markup = profileSwitcherMarkup({
      activeProfileId: 'profile-main',
      transitionBlocker: '仍有任务正在运行',
      profiles: [profile('profile-main', '默认资料', true)],
    })

    expect(markup).toContain('role="status"')
    expect(markup).toContain('仍有任务正在运行')
  })
})
