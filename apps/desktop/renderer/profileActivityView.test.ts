import { describe, expect, it } from 'vitest'
import { activityDayLabel, profileActivityMarkup } from './profileActivityView'
import { profileAvatarMarkup, profileGreeting } from './profileIdentity'

describe('personal activity calendar and greeting', () => {
  it('renders every leap-year day exactly once and disables future days', () => {
    const markup = profileActivityMarkup({ recordedSince: 1, days: { '2024-02-29': 1200, '2024-03-01': 1 } }, 2024, new Date(2024, 2, 1, 12))
    const dates = [...markup.matchAll(/data-day="([^"]+)"/g)].map(match => match[1])
    expect(dates).toHaveLength(366)
    expect(new Set(dates).size).toBe(366)
    expect(markup).toMatch(/data-day="2024-02-29" data-tokens="1200" data-level="4"/)
    expect(markup).toMatch(/data-day="2024-03-01" data-tokens="1" data-level="1"/)
    expect(markup).toMatch(/data-day="2024-03-02"[^>]+disabled/)
    expect(markup).toContain('活跃 <strong>2</strong> 天')
    expect(activityDayLabel('2024-02-29', 1200)).toBe('2024年2月29日 · 1,200 Token')
  })
  it.each([[0, '夜深了'], [5, '夜深了'], [6, '早上好'], [10, '早上好'], [11, '中午好'], [13, '中午好'], [14, '下午好'], [17, '下午好'], [18, '晚上好'], [23, '晚上好']])('greets according to local hour %s', (hour, label) => {
    expect(profileGreeting(new Date(2026, 8, 19, Number(hour)))).toBe(label)
  })
  it('keeps initials and image data safe in markup', () => {
    expect(profileAvatarMarkup({ displayName: '<script>' })).toBe('&lt;')
    expect(profileAvatarMarkup({ displayName: '小明', avatarDataUrl: 'https://example.com/avatar' })).toBe('小')
    expect(profileAvatarMarkup({ displayName: '🙂' })).toBe('🙂')
  })
})
