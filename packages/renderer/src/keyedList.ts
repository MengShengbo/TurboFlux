export interface KeyedListOptions<Item, Element> {
  key(item: Item): string
  create(item: Item): Element
  update(element: Element, item: Item, index: number, force: boolean): void
  place(element: Element, previous: Element | undefined, index: number): void
  remove(element: Element): void
}

/** Retains node identity and disposes removed entries; the host owns DOM placement. */
export class KeyedList<Item, Element> {
  private readonly elements = new Map<string, Element>()

  constructor(private readonly options: KeyedListOptions<Item, Element>) {}

  get(key: string): Element | undefined { return this.elements.get(key) }

  render(items: readonly Item[], force = false): void {
    const keys = items.map(item => this.options.key(item))
    const desired = new Set(keys)
    if (desired.size !== keys.length) throw new Error('Duplicate render key')
    for (const [key, element] of this.elements) {
      if (desired.has(key)) continue
      this.options.remove(element)
      this.elements.delete(key)
    }
    let previous: Element | undefined
    items.forEach((item, index) => {
      const key = keys[index]
      let element = this.elements.get(key)
      if (element === undefined) {
        element = this.options.create(item)
        this.elements.set(key, element)
      }
      this.options.update(element, item, index, force)
      this.options.place(element, previous, index)
      previous = element
    })
  }

  clear(): void {
    for (const element of this.elements.values()) this.options.remove(element)
    this.elements.clear()
  }
}
