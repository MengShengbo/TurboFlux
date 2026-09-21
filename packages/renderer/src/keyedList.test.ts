import { describe, expect, it } from 'vitest'
import { KeyedList } from './keyedList'

describe('keyed rendering', () => {
  it('retains disclosure and selection identity through updates and reordering', () => {
    let created = 0; const removed: string[] = []; let order: string[] = []
    const list = new KeyedList<{ id: string; text: string }, { id: string; text: string; expanded: boolean }>({
      key: item => item.id,
      create: item => { created++; return { ...item, expanded: false } },
      update: (element, item) => { element.text = item.text },
      place: element => { order.push(element.id) },
      remove: element => { removed.push(element.id) },
    })
    list.render([{ id: 'a', text: 'old' }, { id: 'b', text: 'two' }])
    const first = list.get('a')!; first.expanded = true; order = []
    list.render([{ id: 'b', text: 'two' }, { id: 'a', text: 'new' }])
    expect(list.get('a')).toBe(first); expect(first).toMatchObject({ text: 'new', expanded: true })
    expect(created).toBe(2); expect(order).toEqual(['b', 'a'])
    list.render([{ id: 'a', text: 'new' }]); expect(removed).toEqual(['b'])
    expect(() => list.render([{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }])).toThrow('Duplicate render key')
    list.clear(); expect(removed).toEqual(['b', 'a'])
  })
})
