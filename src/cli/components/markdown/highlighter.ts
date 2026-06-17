import chalk from 'chalk'
import hljs from 'highlight.js'

const CLASS_TO_CHALK: Record<string, (text: string) => string> = {
  'keyword': (t) => chalk.cyan(t),
  'built_in': (t) => chalk.magenta(t),
  'type': (t) => chalk.magenta(t),
  'literal': (t) => chalk.yellow(t),
  'number': (t) => chalk.yellow(t),
  'string': (t) => chalk.green(t),
  'comment': (t) => chalk.dim(t),
  'doctag': (t) => chalk.dim(t),
  'function': (t) => chalk.blue(t),
  'title': (t) => chalk.blue(t),
  'title.function': (t) => chalk.blue(t),
  'title.class': (t) => chalk.magenta(t),
  'params': (t) => t,
  'variable': (t) => chalk.red(t),
  'attr': (t) => chalk.yellow(t),
  'attribute': (t) => chalk.yellow(t),
  'property': (t) => chalk.cyan(t),
  'meta': (t) => chalk.dim(t),
  'regexp': (t) => chalk.red(t),
  'operator': (t) => chalk.dim(t),
  'punctuation': (t) => chalk.dim(t),
  'tag': (t) => chalk.cyan(t),
  'name': (t) => chalk.cyan(t),
  'selector-tag': (t) => chalk.cyan(t),
  'selector-class': (t) => chalk.yellow(t),
  'selector-id': (t) => chalk.blue(t),
}

export function highlightCode(code: string, language?: string): string {
  try {
    const result = language
      ? hljs.highlight(code, { language, ignoreIllegals: true })
      : hljs.highlightAuto(code)
    return parseHljsHtml(result.value)
  } catch {
    return code
  }
}

function parseHljsHtml(html: string): string {
  let output = ''
  let i = 0

  while (i < html.length) {
    if (html[i] === '<') {
      const closeTag = html.indexOf('>', i)
      if (closeTag === -1) break

      const tag = html.slice(i, closeTag + 1)

      if (tag.startsWith('</')) {
        i = closeTag + 1
        continue
      }

      const classMatch = tag.match(/class="hljs-([^"]*)"/)
      const className = classMatch ? classMatch[1] : ''

      const endTag = findClosingTag(html, closeTag + 1)
      const content = html.slice(closeTag + 1, endTag)
      const innerText = parseHljsHtml(content)

      const colorFn = CLASS_TO_CHALK[className]
      output += colorFn ? colorFn(innerText) : innerText

      const afterClose = html.indexOf('>', endTag)
      i = afterClose + 1
    } else if (html.startsWith('&amp;', i)) {
      output += '&'; i += 5
    } else if (html.startsWith('&lt;', i)) {
      output += '<'; i += 4
    } else if (html.startsWith('&gt;', i)) {
      output += '>'; i += 4
    } else if (html.startsWith('&quot;', i)) {
      output += '"'; i += 6
    } else if (html.startsWith('&#x27;', i)) {
      output += "'"; i += 6
    } else {
      output += html[i]
      i++
    }
  }

  return output
}

function findClosingTag(html: string, start: number): number {
  let depth = 1
  let i = start

  while (i < html.length && depth > 0) {
    if (html[i] === '<') {
      if (html[i + 1] === '/') {
        depth--
        if (depth === 0) return i
      } else if (html[i + 1] !== '!' && !html.slice(i).startsWith('<br')) {
        depth++
      }
    }
    i++
  }

  return i
}
