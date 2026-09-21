/** Executed in a page/frame. Keep this function self-contained and browser-only. */
function installBrowserDOM(scope: string) {
  const key = `__turboflux_browser_${scope}`
  const host = window as unknown as Record<string, ReturnType<typeof createDOM>>
  if (!host[key]) Object.defineProperty(host, key, { value: createDOM(), configurable: true })
  return host[key]

  function createDOM() {
    let refs = new Map<string, { element: Element; fingerprint: string }>()
    const compact = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    const parent = (element: Element): Element | null => element.parentElement || (element.getRootNode() as ShadowRoot).host || null
    const ancestors = (element: Element, check: (node: Element) => boolean): boolean => {
      for (let node: Element | null = element; node; node = parent(node)) if (check(node)) return true
      return false
    }
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return element.isConnected && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
        && rect.width > 0 && rect.height > 0 && !ancestors(element, node => node.hasAttribute('hidden') || getComputedStyle(node).contentVisibility === 'hidden')
    }
    const enabled = (element: Element) => !element.matches(':disabled') && !ancestors(element, node => node.hasAttribute('inert') || node.getAttribute('aria-disabled') === 'true')
    const labelledText = (element: Element, attribute: string) => {
      const root = element.getRootNode() as Document | ShadowRoot
      return compact((element.getAttribute(attribute) || '').split(/\s+/).map(id => root.getElementById(id)?.textContent || '').join(' '))
    }
    const name = (element: Element): string => labelledText(element, 'aria-labelledby') || compact(element.getAttribute('aria-label'))
      || compact('labels' in element ? Array.from((element as HTMLInputElement).labels || []).map(label => label.textContent).join(' ') : '')
      || compact(element instanceof HTMLInputElement && ['submit', 'reset', 'button'].includes(element.type) ? element.value : '')
      || compact((element as HTMLElement).innerText) || compact(element.getAttribute('alt')) || compact(element.getAttribute('title'))
      || compact(element.getAttribute('placeholder')) || compact(element.getAttribute('name'))
    const role = (element: Element): string => {
      const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0]
      if (explicit) return explicit
      if (element instanceof HTMLInputElement) {
        if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button'
        return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'file' } as Record<string, string>)[element.type] || 'textbox'
      }
      return ({ A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' } as Record<string, string>)[element.tagName] || (element instanceof HTMLElement && element.isContentEditable ? 'textbox' : element.tagName.toLowerCase())
    }
    const fingerprint = (element: Element) => JSON.stringify([element.tagName, element.getAttribute('type'), role(element), name(element), element.getAttribute('href'), element.getAttribute('formaction')])
    const resolve = (ref: string) => {
      const saved = refs.get(ref)
      if (!saved?.element.isConnected || saved.fingerprint !== fingerprint(saved.element)) throw new Error('Element ref is stale; observe the page again')
      return saved.element
    }
    const walk = () => {
      const elements: Element[] = []
      const roots: (Document | ShadowRoot)[] = [document]
      let truncated = false
      for (let index = 0; index < roots.length && elements.length < 12_000; index++) {
        for (const element of roots[index].querySelectorAll('*')) {
          if (elements.length >= 12_000) { truncated = true; break }
          elements.push(element)
          if (element.shadowRoot) roots.push(element.shadowRoot)
        }
      }
      return { elements, roots, truncated }
    }
    const text = () => {
      const { roots } = walk()
      return [document.body?.innerText || '', ...roots.slice(1).flatMap(root => [...root.children].filter(visible).map(element => (element as HTMLElement).innerText || element.textContent || ''))].join('\n').slice(0, 10_001)
    }
    const probe = (ref: string, scroll = false) => {
      const element = resolve(ref)
      if (scroll) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const rect = element.getBoundingClientRect()
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top)
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
      const x = (left + right) / 2, y = (top + bottom) / 2
      let hit = document.elementFromPoint(x, y)
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(x, y)
        if (!nested || nested === hit) break
        hit = nested
      }
      const receivesEvents = right > left && bottom > top && Boolean(hit && ancestors(hit, node => node === element))
      const editable = (element instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type)
        || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)
        && !(element as HTMLInputElement).readOnly && element.getAttribute('aria-readonly') !== 'true'
      return {
        name: name(element), role: role(element), visible: visible(element), enabled: enabled(element), editable,
        receivesEvents, blocker: !receivesEvents && hit ? `${hit.tagName.toLowerCase()} ${name(hit)}`.slice(0, 240) : undefined,
        checked: element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true',
        value: element instanceof HTMLInputElement && element.type === 'password' ? undefined
          : element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.value.slice(0, 2000)
            : element instanceof HTMLElement && element.isContentEditable ? element.innerText.slice(0, 2000) : undefined,
        href: element instanceof HTMLAnchorElement ? element.href : undefined,
        x, y, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    }
    const observe = (prefix: string, maximum: number, query = '', requestedRole = '') => {
      refs = new Map()
      const tree = walk()
      const selector = 'a[href],button,input,textarea,select,summary,canvas,[role],[tabindex],[contenteditable]:not([contenteditable="false"])'
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
      const candidates = tree.elements.filter(element => element.matches(selector) && visible(element)
        && !ancestors(element, node => node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')))
        .map(element => {
          const description = element instanceof HTMLAnchorElement ? element.href : labelledText(element, 'aria-describedby') || compact(element.getAttribute('placeholder'))
          return { element, name: name(element), role: role(element), description }
        })
        .filter(item => (!requestedRole || item.role.toLowerCase() === requestedRole.toLowerCase()) && terms.every(term => `${item.name} ${item.role} ${item.description}`.toLocaleLowerCase().includes(term)))
      if (query) candidates.sort((a, b) => Number(b.name.toLowerCase() === query.toLowerCase()) - Number(a.name.toLowerCase() === query.toLowerCase()))
      const elements = candidates.slice(0, maximum).map((item, index) => {
        const ref = `${prefix}-e${index + 1}`
        refs.set(ref, { element: item.element, fingerprint: fingerprint(item.element) })
        const state = probe(ref)
        return {
          ref, role: item.role, name: item.name, description: item.description.slice(0, 300), disabled: !state.enabled,
          checked: ['checkbox', 'radio'].includes(item.role) ? state.checked : undefined,
          value: state.value?.slice(0, 240), bounds: state.bounds,
          options: item.element instanceof HTMLSelectElement ? [...item.element.options].slice(0, 80).map(option => option.value || option.text) : undefined,
        }
      })
      const rawText = query ? '' : text()
      return { title: document.title, url: location.href, text: rawText.slice(0, 10_000), elements,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
        truncated: tree.truncated || candidates.length > maximum || rawText.length > 10_000 }
    }
    const inspect = (ref?: string) => {
      const page = { title: document.title, url: location.href, readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, deviceScaleFactor: devicePixelRatio },
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }
      if (!ref) return { page }
      const element = resolve(ref), style = getComputedStyle(element)
      return { page, element: { ...probe(ref), tag: element.tagName.toLowerCase(), id: element.id,
        styles: Object.fromEntries(['display', 'visibility', 'position', 'overflow', 'color', 'background-color', 'font-size', 'font-family', 'line-height', 'opacity', 'z-index', 'pointer-events'].map(property => [property, style.getPropertyValue(property)])) } }
    }
    return { resolve, observe, probe, inspect, text }
  }
}

export function browserDOMScript(scope: string, body: string): string {
  // tsx/esbuild may preserve function names with this helper when serializing the function.
  return `(() => { const __name = value => value; const dom = (${installBrowserDOM.toString()})(${JSON.stringify(scope)}); ${body} })()`
}
