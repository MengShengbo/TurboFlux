import { describe, it, expect } from 'vitest'
import { applyEdit, stripLineNumberPrefix } from './editHelpers'

describe('stripLineNumberPrefix', () => {
  it('returns empty string for undefined', () => {
    expect(stripLineNumberPrefix(undefined)).toBe('')
  })

  it('returns empty string unchanged', () => {
    expect(stripLineNumberPrefix('')).toBe('')
  })

  it('returns input unchanged when no arrow character is present', () => {
    const raw = 'function foo() {\n  return 1\n}'
    expect(stripLineNumberPrefix(raw)).toBe(raw)
  })

  it('strips cat -n style prefix on every line of a multi-line block', () => {
    const input = '    42\u2192function foo() {\n    43\u2192  return 1\n    44\u2192}'
    expect(stripLineNumberPrefix(input)).toBe('function foo() {\n  return 1\n}')
  })

  it('handles single-line input', () => {
    expect(stripLineNumberPrefix('   1\u2192hello')).toBe('hello')
  })

  it('preserves indentation that is part of the actual content', () => {
    const input = '    42\u2192  indented line'
    expect(stripLineNumberPrefix(input)).toBe('  indented line')
  })

  it('returns input unchanged when only some lines have the prefix', () => {
    const input = '    42\u2192function f() {\nconst arrow = "\u2192"\n    44\u2192}'
    expect(stripLineNumberPrefix(input)).toBe(input)
  })

  it('preserves empty lines inside an otherwise-prefixed block', () => {
    const input = '    1\u2192a\n\n    3\u2192c'
    expect(stripLineNumberPrefix(input)).toBe('a\n\nc')
  })

  it('does not strip arrows in source code that lack the line-number prefix', () => {
    const input = 'type Arrow = "\u2192"\nconst x = 1'
    expect(stripLineNumberPrefix(input)).toBe(input)
  })
})

describe('applyEdit', () => {
  it('replaces a unique occurrence and reports 1 replacement', () => {
    const result = applyEdit('hello world', 'world', 'there', false, 'a.ts')
    expect(result).toEqual({ content: 'hello there', replacements: 1 })
  })

  it('errors on empty old_string', () => {
    const result = applyEdit('hello', '', 'x', false, 'a.ts')
    expect(result).toEqual({ error: expect.stringContaining('cannot be empty') })
  })

  it('errors on identical old_string and new_string', () => {
    const result = applyEdit('hello', 'hello', 'hello', false, 'a.ts')
    expect(result).toEqual({ error: expect.stringContaining('identical') })
  })

  it('errors when old_string is not found', () => {
    const result = applyEdit('hello', 'goodbye', 'x', false, 'a.ts')
    expect(result).toEqual({ error: expect.stringContaining('not found') })
  })

  it('errors on multiple matches without replace_all', () => {
    const result = applyEdit('foo bar foo', 'foo', 'baz', false, 'a.ts')
    expect(result).toEqual({ error: expect.stringContaining('2 occurrences') })
  })

  it('replaces all occurrences when replace_all=true', () => {
    const result = applyEdit('foo bar foo baz foo', 'foo', 'X', true, 'a.ts')
    expect(result).toEqual({ content: 'X bar X baz X', replacements: 3 })
  })

  it('replace_all=true succeeds even with a single occurrence', () => {
    const result = applyEdit('only foo here', 'foo', 'bar', true, 'a.ts')
    expect(result).toEqual({ content: 'only bar here', replacements: 1 })
  })

  it('replace_all=true still errors on zero occurrences', () => {
    const result = applyEdit('no match', 'foo', 'bar', true, 'a.ts')
    expect('error' in result).toBe(true)
  })

  it('preserves whitespace and indentation exactly', () => {
    const src = 'function f() {\n  const x = 1\n  return x\n}'
    const result = applyEdit(src, '  const x = 1', '  const x = 42', false, 'a.ts')
    expect(result).toEqual({
      content: 'function f() {\n  const x = 42\n  return x\n}',
      replacements: 1,
    })
  })

  it('handles multi-line old_string', () => {
    const src = 'a\nb\nc\nd'
    const result = applyEdit(src, 'b\nc', 'B\nC', false, 'a.ts')
    expect(result).toEqual({ content: 'a\nB\nC\nd', replacements: 1 })
  })

  it('error messages include the path label for diagnostic context', () => {
    const result = applyEdit('x', 'y', 'z', false, 'src/components/Button.tsx')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('src/components/Button.tsx')
    }
  })

  it('replace_all surfaces a clear hint to switch when ambiguous match without flag', () => {
    const result = applyEdit('a a a', 'a', 'b', false, 'a.ts')
    if ('error' in result) {
      expect(result.error).toMatch(/replace_all=true/)
    } else {
      throw new Error('expected error')
    }
  })
})

describe('integration: read_file output -> applyEdit', () => {
  const sourceFile = 'function greet() {\n  return "hello"\n}'
  const numberedSnippet = '     1\u2192function greet() {\n     2\u2192  return "hello"\n     3\u2192}'

  it('stripping the numbered snippet yields the original source', () => {
    expect(stripLineNumberPrefix(numberedSnippet)).toBe(sourceFile)
  })

  it('applyEdit succeeds when given the stripped snippet as old_string', () => {
    const stripped = stripLineNumberPrefix(numberedSnippet)
    const result = applyEdit(sourceFile, stripped, 'function greet() {\n  return "hi"\n}', false, 'greet.ts')
    expect('content' in result).toBe(true)
  })
})
