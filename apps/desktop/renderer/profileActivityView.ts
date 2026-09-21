import type { DesktopUserActivity } from '../desktopTypes'

export function activityDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function activityLevel(tokens: number, maximum: number): number {
  if (tokens <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(tokens / Math.max(1, maximum)) * 4)))
}

export function activityDayLabel(date: string, tokens: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${year}年${month}月${day}日 · ${tokens.toLocaleString('zh-CN')} Token`
}

export function profileActivityMarkup(activity: DesktopUserActivity, year: number, now = new Date()): string {
  const today = activityDateKey(now)
  const counts = Object.entries(activity.days).filter(([day]) => day.startsWith(`${year}-`) && day <= today)
  const maximum = Math.max(1, ...counts.map(([, count]) => count))
  const activeDays = counts.filter(([, count]) => count > 0).length
  const total = counts.reduce((sum, [, count]) => sum + count, 0)
  const halves = [0, 6].map(startMonth => {
    const first = new Date(year, startMonth, 1, 12)
    const last = new Date(year, startMonth + 6, 0, 12)
    const start = new Date(first)
    start.setDate(start.getDate() - start.getDay())
    const weeks: string[] = []
    const months: string[] = []
    const cursor = new Date(start)
    while (cursor <= last) {
      let monthLabel = ''
      const cells: string[] = []
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const inRange = cursor >= first && cursor <= last
        const date = activityDateKey(cursor)
        if (inRange && cursor.getDate() === 1) monthLabel = `${cursor.getMonth() + 1}月`
        const count = activity.days[date] || 0
        const future = date > today
        cells.push(inRange
          ? `<button type="button" class="profile-activity-day${date === today ? ' is-today' : ''}" data-day="${date}" data-tokens="${future ? 0 : count}" data-level="${future ? 0 : activityLevel(count, maximum)}" tabindex="${date === today || (year < now.getFullYear() && date === `${year}-12-31`) ? '0' : '-1'}" aria-label="${activityDayLabel(date, future ? 0 : count)}${future ? '，尚未到来' : ''}" ${future ? 'disabled' : ''}></button>`
          : '<span class="profile-activity-spacer" aria-hidden="true"></span>')
        cursor.setDate(cursor.getDate() + 1)
      }
      months.push(`<span>${monthLabel}</span>`)
      weeks.push(`<div class="profile-activity-week">${cells.join('')}</div>`)
    }
    return `<div class="profile-activity-half"><div class="profile-activity-months" style="--weeks:${weeks.length}">${months.join('')}</div><div class="profile-activity-calendar"><div class="profile-activity-weekdays" aria-hidden="true"><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span></div><div class="profile-activity-weeks" style="--weeks:${weeks.length}" role="group" aria-label="${year}年${startMonth + 1}月至${startMonth + 6}月 Token 活动">${weeks.join('')}</div></div></div>`
  }).join('')
  return `<div class="profile-activity-summary"><span>活跃 <strong>${activeDays}</strong> 天</span><span><strong>${total.toLocaleString('zh-CN')}</strong> Token</span></div>${halves}<div class="profile-activity-legend"><div aria-label="颜色越深，Token 消耗越多"><span>少</span>${[0, 1, 2, 3, 4].map(level => `<i data-level="${level}"></i>`).join('')}<span>多</span></div></div>`
}
